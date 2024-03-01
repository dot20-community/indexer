import { Deploy, PrismaClient } from '@prisma/client';
import { Inscription, OP } from './types.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { parentPort } from 'worker_threads';

const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 120000,
  },
});

const queue: Inscription[][] = [];
const bufferSize = 128;

parentPort!.on('message', (blockInscriptions: Inscription[]) => {
  queue.push(blockInscriptions);
});

void (async function () {
  let isPaused = false;
  setInterval(() => {
    if (queue.length > bufferSize) {
      if (!isPaused) {
        isPaused = true;
        parentPort!.postMessage('pause');
      }
    } else if (isPaused) {
      isPaused = false;
      parentPort!.postMessage('resume');
    }
  }, 1000);

  await deployDota();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const blockInscriptions = queue.shift();
    if (blockInscriptions) {
      console.time('handelInscriptions');
      try {
        await handelInscriptions(blockInscriptions);
      } catch (e) {
        console.error('handelInscriptions error', e);
      }
      console.timeEnd('handelInscriptions');
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
})();

async function deployDota() {
  const deploy = await prisma.deploy.findFirst({
    where: {
      tick: 'DOTA',
    },
  });
  if (deploy) {
    return;
  }

  await prisma.deploy.create({
    data: {
      from: '13T28S52mt9aJeoQpzHHxq1LEcwDaK9iTMERJsdK2Tqvftfo',
      to: '13T28S52mt9aJeoQpzHHxq1LEcwDaK9iTMERJsdK2Tqvftfo',
      blockNumber: 18681993,
      extrinsicHash:
        '0x095d41d1065009f9fdac2cecd53a25cc777fce3d199758032d32cb13125fe323',
      tick: 'DOTA',
      amount: 5000000,
      start: 18681993,
      end: 18723993,
      created: new Date(1703081268000),
    },
  });
}

async function handelInscriptions(blockInscriptions: Inscription[]) {
  const classfyInscriptions: Record<OP, Inscription[]> = {
    deploy: [],
    mint: [],
    transfer: [],
  };
  for (const inscription of blockInscriptions) {
    classfyInscriptions[inscription.content.op].push(inscription);
  }

  if (classfyInscriptions.deploy.length > 0) {
    await handleDeploy(classfyInscriptions.deploy);
  }
  if (classfyInscriptions.mint.length > 0) {
    await handleMint(classfyInscriptions.mint);
  }
  if (classfyInscriptions.transfer.length > 0) {
    await handleTransfer(classfyInscriptions.transfer);
  }

  try {
    await saveInscriptionBatch(Object.values(classfyInscriptions).flat());
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
      return;
    }
    throw e;
  }
}

async function handleDeploy(inscriptions: Inscription[]) {
  for (const inscription of inscriptions) {
    if (!inscription.content.start) {
      console.warn(
        'Deploy field start is missing',
        JSON.stringify(inscription),
      );
      continue;
    }

    const deploy = await findDeployByTick(inscription.content.tick);
    if (deploy) {
      console.warn(
        `Deploy "${inscription.content.tick}" already exists`,
        JSON.stringify(inscription),
      );
      continue;
    }

    await prisma.deploy.create({
      data: {
        from: inscription.from,
        to: inscription.to,
        blockNumber: inscription.blockNumber,
        extrinsicHash: inscription.extrinsicHash,
        tick: inscription.content.tick,
        amount: inscription.content.amt || 5000000,
        start: inscription.content.start,
        end: inscription.content.end || inscription.content.start + 420000,
        created: inscription.timestamp,
      },
    });
  }
}

async function handleMint(blockInscriptions: Inscription[]) {
  const tickUserInscriptions: Record<string, Record<string, Inscription>> = {};
  for (const inscription of blockInscriptions) {
    if (!tickUserInscriptions[inscription.content.tick]) {
      tickUserInscriptions[inscription.content.tick] = {};
    }
    tickUserInscriptions[inscription.content.tick][inscription.from] =
      inscription;
  }

  for (const [tick, userInscriptions] of Object.entries(tickUserInscriptions)) {
    const inscription = Object.values(userInscriptions)[0];
    const deploy = await findDeployByTick(tick);
    if (!deploy) {
      console.warn(
        `Mint "${tick}" without deploy`,
        JSON.stringify(inscription),
      );
      continue;
    }

    if (
      inscription.blockNumber < deploy.start ||
      inscription.blockNumber > deploy.end
    ) {
      console.warn(
        `Mint "${tick}" not in deploy block range`,
        JSON.stringify(inscription),
      );
      continue;
    }

    const userCount = Object.keys(userInscriptions).length;
    const avgAmount = Math.trunc(Number(deploy.amount) / userCount);
    const allInscriptions = Object.values(userInscriptions);
    const existUserAccounts = await prisma.account.findMany({
      where: {
        address: {
          in: allInscriptions.map((i) => i.from),
        },
        tick,
      },
    });
    const newUserAccounts = allInscriptions.filter(
      (i) => !existUserAccounts.some((a) => a.address === i.from),
    );

    try {
      await prisma.$transaction(async (tx) => {
        await saveAccountTxBatch(allInscriptions, avgAmount);
        if (newUserAccounts.length > 0) {
          await tx.account.createMany({
            data: newUserAccounts.map((i) => ({
              address: i.from,
              tick,
              amount: avgAmount,
              created: i.timestamp,
              updated: i.timestamp,
            })),
          });
        }
        if (existUserAccounts.length > 0) {
          await tx.account.updateMany({
            where: {
              id: {
                in: existUserAccounts.map((a) => a.id),
              },
            },
            data: {
              amount: {
                increment: avgAmount,
              },
              updated: {
                set: inscription.timestamp,
              },
            },
          });
        }
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        continue;
      }
      throw e;
    }
  }
}

async function handleTransfer(inscriptions: Inscription[]) {
  for (const inscription of inscriptions) {
    if (inscription.from === inscription.to) {
      console.warn(
        'Transfer from and to are the same',
        JSON.stringify(inscription),
      );
      continue;
    }
    if ((inscription.content.amt || 0) <= 0) {
      console.warn(
        'Transfer amount is less than or equal to 0',
        JSON.stringify(inscription),
      );
      continue;
    }

    const deploy = await findDeployByTick(inscription.content.tick);
    if (!deploy) {
      console.warn(
        `Transfer "${inscription.content.tick}" without deploy`,
        JSON.stringify(inscription),
      );
      continue;
    }
    if (inscription.blockNumber < deploy.end) {
      console.warn(
        `Transfer "${inscription.content.tick}" must be after deploy end`,
        JSON.stringify(inscription),
      );
      continue;
    }

    const account = await prisma.account.findFirst({
      where: {
        address: inscription.from,
        tick: inscription.content.tick,
      },
    });
    if ((account?.amount || 0) < inscription.content.amt!) {
      console.warn(
        'Transfer amount exceeds balance',
        JSON.stringify(inscription),
      );
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await saveAccountTx(inscription, -inscription.content.amt!);
        await tx.account.update({
          where: {
            address_tick: {
              address: inscription.from,
              tick: inscription.content.tick,
            },
          },
          data: {
            amount: {
              decrement: inscription.content.amt,
            },
            updated: inscription.timestamp,
          },
        });
        await tx.account.upsert({
          where: {
            address_tick: {
              address: inscription.to,
              tick: inscription.content.tick,
            },
          },
          update: {
            amount: {
              increment: inscription.content.amt,
            },
            updated: inscription.timestamp,
          },
          create: {
            address: inscription.to,
            tick: inscription.content.tick,
            amount: inscription.content.amt!,
            created: inscription.timestamp,
            updated: inscription.timestamp,
          },
        });
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        continue;
      }
      throw e;
    }
  }
}

async function findDeployByTick(tick: string): Promise<Deploy | null> {
  return await prisma.deploy.findFirst({
    where: {
      tick,
    },
  });
}

async function saveInscriptionBatch(inscriptions: Inscription[]) {
  await prisma.inscription.createMany({
    data: inscriptions.map((i) => ({
      from: i.from,
      to: i.to,
      blockNumber: i.blockNumber,
      extrinsicHash: i.extrinsicHash,
      transfer: i.transfer,
      content: i.rawContent,
      created: i.timestamp,
    })),
  });
}

async function saveAccountTx(inscription: Inscription, amount: number) {
  await prisma.accountTx.create({
    data: {
      from: inscription.from,
      to: inscription.to,
      blockNumber: inscription.blockNumber,
      extrinsicHash: inscription.extrinsicHash,
      tick: inscription.content.tick,
      op: inscription.content.op,
      amount: amount,
      created: inscription.timestamp,
    },
  });
}

async function saveAccountTxBatch(incription: Inscription[], amount: number) {
  await prisma.accountTx.createMany({
    data: incription.map((i) => ({
      from: i.from,
      to: i.to,
      blockNumber: i.blockNumber,
      extrinsicHash: i.extrinsicHash,
      tick: i.content.tick,
      op: i.content.op,
      amount: amount,
      created: i.timestamp,
    })),
  });
}
