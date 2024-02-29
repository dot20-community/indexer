import { ApiPromise, WsProvider } from '@polkadot/api';
import { Content, Record } from './types.js';

class Scanner {
  blockStart: number;
  endpoint: string;
  concurrency: number;

  private api!: ApiPromise;

  constructor(
    blockStart: number | null,
    endpoint: string | null,
    concurrency: number | null,
  ) {
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

  private async resolveBlock(number: number): Promise<Record[]> {
    const result: Record[] = [];

    const blockHash = await this.api.rpc.chain.getBlockHash(number);
    const signedBlock = await this.api.rpc.chain.getBlock(blockHash);
    signedBlock.block.extrinsics.forEach((ex, ei) => {
      if (ex.method.method === 'batchAll' && ex.method.section === 'utility') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const methodJson = ex.method.toHuman() as any;
        if (!methodJson?.args?.calls || methodJson.args.calls.length !== 2) {
          return;
        }

        const call0 = methodJson.args.calls[0];
        if (
          call0?.method !== 'transferKeepAlive' ||
          call0?.section !== 'balances' ||
          !call0?.args?.dest?.Id ||
          !call0?.args?.value
        ) {
          return;
        }

        const call1 = methodJson.args.calls[1];
        if (
          call1?.method !== 'remark' ||
          call1?.method !== 'remarkWithEvent' ||
          call1?.section !== 'system' ||
          !call1?.args?.remark
        ) {
          return;
        }

        const remark = call1.args.remark as string;
        // Try to parse the remark as a JSON object
        let content: Content;
        try {
          content = JSON.parse(remark);
        } catch (err) {
          console.error('failed to parse remark as JSON', remark);
          return;
        }

        result.push({
          blockNumber: number,
          blockHash: blockHash.toHex(),
          extrinsicIndex: ei,
          extrinsicHash: ex.hash.toHex(),
          from: ex.signer.toString(),
          to: call0.args.dest.Id,
          content,
        });
      }
    });

    return result;
  }

  // eslint-disable-next-line no-unused-vars
  async scan(handler: (record: Record) => Promise<void>) {
    let current = this.blockStart;
    let headBlockNumber = await this.getHeadBlockNumber();
    const startTime = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (current > headBlockNumber) {
          console.log('waiting for new blocks');
          await new Promise((resolve) => setTimeout(resolve, 5000));
          headBlockNumber = await this.getHeadBlockNumber();
          continue;
        }

        const diff = headBlockNumber - current;
        const blocksToScan = Math.min(diff, this.concurrency);
        const tasks = Array.from({ length: blocksToScan }, (_, i) =>
          this.resolveBlock(current + i),
        );

        const records = (await Promise.all(tasks)).flat();
        for (const record of records) {
          await handler(record);
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
}

export default Scanner;
