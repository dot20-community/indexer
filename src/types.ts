export type OP = 'deploy' | 'mint' | 'transfer';

export type Content = {
  p: string;
  op: OP;
  tick: string;
  amt: number;
  start: number;
  end: number;
};

export type Extrinsic = {
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
  extrinsicHash: string;
  from: string;
  to: string;
};

export type Record = Extrinsic & {
  from: string;
  to: string;
  content: Content;
};

export type Deploy = Extrinsic & {
  blockEnd: number;
};
