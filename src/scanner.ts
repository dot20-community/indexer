import { ApiPromise, WsProvider } from '@polkadot/api';
import { Content, Inscription, OP } from './types.js';

class Scanner {
  blockStart: number;
  endpoint: string;
  concurrency: number;

  private supportOPs: OP[] = ['deploy', 'mint', 'transfer'];
  private api!: ApiPromise;

  constructor(blockStart?: number, endpoint?: string, concurrency?: number) {
    this.blockStart = blockStart || 0;
    this.endpoint = endpoint || 'wss://rpc.polkadot.io';
    this.concurrency = concurrency || 8;
  }

  async init() {
    const wsProvider = new WsProvider(this.endpoint);
    this.api = await ApiPromise.create({ provider: wsProvider });
  }

  async reconnect() {
    await this.api.disconnect();
    await this.init();
  }

  private async getHeadBlockNumber(): Promise<number> {
    const finalizedHead = await this.api.rpc.chain.getFinalizedHead();
    const header = await this.api.rpc.chain.getHeader(finalizedHead);
    return header.number.toNumber();
  }

  private async resolveBlock(number: number): Promise<Inscription[]> {
    const blockHash = await this.api.rpc.chain.getBlockHash(number);
    const signedBlock = await this.api.rpc.chain.getBlock(blockHash);
    if (!signedBlock.block.extrinsics.length) {
      return [];
    }
    let blockTime: number | undefined;
    return (
      await Promise.all(
        signedBlock.block.extrinsics.map(async (ex, ei) => {
          if (
            ex.method.method === 'batchAll' &&
            ex.method.section === 'utility'
          ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const methodJson = ex.method.toHuman() as any;
            if (
              !methodJson?.args?.calls ||
              methodJson.args.calls.length !== 2
            ) {
              return;
            }

            const call0 = methodJson.args.calls[0];
            if (
              call0?.method !== 'transferKeepAlive' ||
              call0?.section !== 'balances' ||
              !call0?.args?.dest?.Id ||
              call0.args.dest.Id.length < 40 ||
              !call0?.args?.value
            ) {
              return;
            }

            const call1 = methodJson.args.calls[1];
            if (
              !['remark'].includes(call1?.method as string) ||
              call1?.section !== 'system' ||
              !call1?.args?.remark
            ) {
              return;
            }

            // Remove the spaces in the memo, replace single quotes with double quotes, then convert everything to lowercase
            const remark = (call1.args.remark as string)
              .replaceAll(' ', '')
              .replaceAll("'", '"')
              .toLowerCase();
            // Try to parse the remark as a JSON object
            let content: Content;
            try {
              content = JSON.parse(remark);
            } catch (err) {
              return;
            }

            if (
              content.p !== 'dot-20' ||
              !this.supportOPs.includes(content.op) ||
              !content.tick
            ) {
              return;
            }

            if (!blockTime) {
              blockTime = await this.getBlockTime(blockHash);
            }

            return {
              blockNumber: number,
              blockHash: blockHash.toHex(),
              extrinsicIndex: ei,
              extrinsicHash: ex.hash.toHex(),
              from: ex.signer.toString(),
              to: call0.args.dest.Id,
              transfer: parseInt(
                (call0.args.value as string).replace(/,/g, ''),
              ),
              rawContent: call1.args.remark,
              trimContent: remark,
              content: content,
              method: call1.method,
              timestamp: new Date(blockTime || 0),
            } as Inscription;
          }
        }),
      )
    )
      .filter((e) => e)
      .map((e) => e as Inscription);
  }

  // eslint-disable-next-line no-unused-vars
  async scan(handler: (blockInscriptions: Inscription[]) => Promise<void>) {
    let current = this.blockStart;
    let headBlockNumber = await this.getHeadBlockNumber();
    const startTime = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const diff = headBlockNumber - current;
        const blocksToScan = Math.min(diff, this.concurrency);
        if (blocksToScan === 0) {
          // waiting for new blocks
          await new Promise((resolve) => setTimeout(resolve, 6000));
          headBlockNumber = await this.getHeadBlockNumber();
          continue;
        }
        const tasks = Array.from({ length: blocksToScan }, (_, i) =>
          this.resolveBlock(current + i),
        );

        const blockInscriptionsBatch = await Promise.all(tasks);
        for (const blockInscriptions of blockInscriptionsBatch) {
          if (!blockInscriptions.length) {
            continue;
          }
          await handler(blockInscriptions);
        }

        const used = (Date.now() - startTime) / 1000;
        const scaned = current - this.blockStart;
        console.log(
          `scanning blocks ${current} to ${current + blocksToScan - 1}: head=${headBlockNumber}, progress=${(
            (current / headBlockNumber) *
            100
          ).toFixed(2)}%, used=${used.toFixed(2)}s, remaining=${(
            (used / scaned) *
            (headBlockNumber - current)
          ).toFixed(2)}s, speed=${(scaned / used).toFixed(2)} blocks/s`,
        );

        current += blocksToScan;
      } catch (error) {
        console.error('scan error', error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await this.reconnect();
      }
    }
  }

  private async getBlockTime(blockHash: Uint8Array | string): Promise<number> {
    const apiAt = await this.api.at(blockHash);
    return parseInt((await apiAt.query.timestamp.now()).toString());
  }
}

export default Scanner;
