import Scanner from './scanner.js';

void (async function () {
  const scanner = new Scanner(
    18600000,
    'wss://rpc.dotters.network/polkadot',
    16,
  );
  // wss://rpc.ibp.network/polkadot
  // wss://rpc.dotters.network/polkadot
  // wss://rpc-polkadot.luckyfriday.io
  // wss://polkadot.api.onfinality.io/public-ws
  // wss://polkadot.public.curie.radiumblock.co/ws
  await scanner.init();
  // eslint-disable-next-line @typescript-eslint/require-await
  await scanner.scan(async (record) => {
    console.log(
      `record found at block=${record.blockHash} extrinsic=${record.extrinsicHash}`,
      JSON.stringify(record),
    );
  });
})();
