import Scanner from './scanner.js';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'worker_threads';

const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 120000,
  },
});

void (async function () {
  const lastBlock =
    (
      await prisma.accountTx.findFirst({
        orderBy: [
          {
            id: 'desc',
          },
        ],
      })
    )?.blockNumber || 18681993;

  console.log('Indexing starts from block', lastBlock);

  let isPaused = false;
  const worker = new Worker('./build/src/consumer.js');
  worker.on('message', (message: string) => {
    if (message === 'pause') {
      isPaused = true;
    }
    if (message === 'resume') {
      isPaused = false;
    }
  });

  // wss://rpc.ibp.network/polkadot
  // wss://rpc.dotters.network/polkadot
  // wss://rpc-polkadot.luckyfriday.io
  // wss://polkadot.api.onfinality.io/public-ws
  // wss://polkadot.public.curie.radiumblock.co/ws
  const scanner = new Scanner(
    Number(lastBlock),
    'wss://polkadot.api.onfinality.io/public-ws',
    16,
  );

  await scanner.init();
  await scanner.scan(async (blockInscriptions) => {
    worker.postMessage(blockInscriptions);
    while (isPaused) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
})();
