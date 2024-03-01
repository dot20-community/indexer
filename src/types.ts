export type OP = 'deploy' | 'mint' | 'transfer';

export type Content = {
  p: string;
  op: OP;
  tick: string;
  amt?: number;
  start?: number;
  end?: number;
};

export type Inscription = {
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
  extrinsicHash: string;
  from: string;
  to: string;
  transfer: number;
  rawContent: string;
  trimContent: string;
  content: Content;
  timestamp: Date;
};
