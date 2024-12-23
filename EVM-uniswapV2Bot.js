const { Wallet, ethers } = require('ethers');
const {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} = require('@flashbots/ethers-provider-bundle');
const fs = require('fs');

const UniswapV2J = fs.readFileSync('UniswapAbi.json');
const UniswapAbi = JSON.parse(UniswapV2J);

const UniswapBytecode = fs.readFileSync('UniswapBytecode.txt');

const UniswapV2FactoryJ = fs.readFileSync('UniswapFactoryAbi.json');
const UniswapFactoryAbi = JSON.parse(UniswapV2FactoryJ);

const UniswapFactoryBytecode = fs.readFileSync('UniswapFactoryBytecode.txt');

const pairJ = fs.readFileSync('pairAbi.json');
const pairAbi = JSON.parse(pairJ);

const pairBytecode = fs.readFileSync('UniswapFactoryBytecode.txt');

const erc20J = fs.readFileSync('erc20Abi.json');
const erc20Abi = JSON.parse(erc20J);

const erc20Bytecode = fs.readFileSync('erc20Bytecode.txt');

const uniswapV3J = fs.readFileSync('uniswapV3Abi.json');
const uniswapV3Abi = JSON.parse(uniswapV3J);

const flashbotsUrl = 'https://relay-goerli.flashbots.net';

const wethAddress = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6';
// const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // mainnet
const uniswapAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const uniswapFactoryAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const universalRouterAddress = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
// const universalRouterAddress = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'; // mainnet
// const httpProviderUrl = 'http://127.0.0.1:8555'; // on the server
const httpProviderUrl =
  'https://goerli.infura.io/v3/41a33488b6794a7aa6878b61d3861d9b';
// const wsProviderUrl = 'ws://127.0.0.1:8556'; // on the server
const wsProviderUrl =
  'wss://goerli.infura.io/ws/v3/41a33488b6794a7aa6878b61d3861d9b';
const privateKey =
  '0x38022fda2446ec8d363538e4684accaa758b4702681494b201a3f4f918ffb90a';
const bribeToMiners = ethers.utils.parseUnits('20', 'gwei');
const buyAmount = ethers.utils.parseUnits('0.01', 'ether');
const chainId = 5;
// const chainId = 1; // mainnet

const provider = new ethers.providers.JsonRpcProvider(httpProviderUrl);
const wsProvider = new ethers.providers.WebSocketProvider(wsProviderUrl);

const signingWallet = new Wallet(privateKey).connect(provider);
const uniswapV3Interface = new ethers.utils.Interface(uniswapV3Abi);
const factoryUniswapFactory = new ethers.ContractFactory(
  UniswapFactoryAbi,
  UniswapFactoryBytecode,
  signingWallet
).attach(uniswapFactoryAddress);
const erc20Factory = new ethers.ContractFactory(
  erc20Abi,
  erc20Bytecode,
  signingWallet
);
const pairFactory = new ethers.ContractFactory(
  pairAbi,
  pairBytecode,
  signingWallet
);
const uniswap = new ethers.ContractFactory(
  UniswapAbi,
  UniswapBytecode,
  signingWallet
).attach(uniswapAddress);
let flashbotsProvider = null;

const decodeUniversalRouterSwap = (input) => {
  const abiCoder = new ethers.utils.AbiCoder();
  const decodedParameters = abiCoder.decode(
    ['address', 'uint256', 'uint256', 'bytes', 'bool'],
    input
  );
  const breakdown = input.substring(2).match(/.{1,64}/g);

  let path = [];
  let hasTwoPath = false;
  if (breakdown.length != 9) {
    const pathOne = '0x' + breakdown[breakdown.length - 2].substring(24);
    const pathTwo = '0x' + breakdown[breakdown.length - 1].substring(24);
    path = [pathOne, pathTwo];
  } else {
    hasTwoPath = true;
  }

  return {
    recipient: parseInt(decodedParameters[(0, 16)]),
    amountIn: decodedParameters[1],
    minAmountOut: decodedParameters[2],
    path,
    hasTwoPath,
  };
};

const initialChecks = async (tx) => {
  let transaction = null;
  let decoded = null;
  let decodedSwap = null;

  try {
    transaction = await provider.getTransaction(tx);
  } catch (err) {
    return false;
  }

  if (!transaction || !transaction.to) return false;
  if (Number(transaction.value) == 0) return false;
  if (transaction.to.toLowerCase() != universalRouterAddress.toLowerCase())
    return false;

  console.log('here');

  try {
    decoded = uniswapV3Interface.parseTransaction(transaction);
  } catch (err) {
    return false;
  }

  // If the swap is not for uniswapV2, we return it
  if (!decoded.args.commands.includes('08')) return false;
  let swapPositionInCommands =
    decoded.args.commands.substring(2).indexOf('08') / 2;
  let inputPosition = decoded.args.inputs[swapPositionInCommands];
  decodedSwap = decodeUniversalRouterSwap(inputPosition);
  if (!decodedSwap.hasTwoPath) return false;
  if (decodedSwap.recipient === 2) return false;
  if (decodedSwap.path[0].toLowerCase() != wethAddress.toLowerCase())
    return false;

  return {
    transaction,
    amountIn: transaction.value,
    minAmountOut: decodedSwap.minAmountOut,
    tokenToCapture: decodedSwap.path[1],
  };
};

const processTransaction = async (tx) => {
  const checksPassed = await initialChecks(tx);
  if (!checksPassed) return false;
  const {
    transaction,
    amountIn, // Victim's ETH
    minAmountOut,
    tokenToCapture,
  } = checksPassed;

  console.log('checks passed', tx);

  const pairAddress = await factoryUniswapFactory.getPair(
    wethAddress,
    tokenToCapture
  );
  const pair = pairFactory.attach(pairAddress);

  let reserves = null;
  try {
    reserves = await pair.getReserves();
  } catch (err) {
    return false;
  }

  let a;
  let b;
  if (wethAddress < tokenToCapture) {
    a = reserves._reserve0;
    b = reserves._reserve1;
  } else {
    a = reserves._reserve1;
    b = reserves._reserve0;
  }

  const maxGasFee = transaction.maxFeePerGas
    ? transaction.maxFeePerGas.add(bribeToMiners)
    : bribeToMiners;
  const priorityFee = transaction.maxPriorityFeePerGas.add(bribeToMiners);

  let firstAmountOut = await uniswap.getAmountOut(buyAmount, a, b);
  const updatedReserveA = a.add(buyAmount);
  const updatedReserveB = b.add(firstAmountOut);
  let secondBuyAmount = await uniswap.getAmountOut(
    amountIn,
    updatedReserveA,
    updatedReserveB
  );

  console.log('secondBuyAmount', secondBuyAmount.toString());
  console.log('minAmountOut', minAmountOut.toString());
  if (secondBuyAmount < minAmountOut)
    return console.log('Victim would get less than the minimum');
  // if (secondBuyAmount < minAmountOut) return console.log('Victim would get less than the minimum');
  const updatedReserveA2 = a.add(buyAmount);
  const updatedReserveB2 = b.add(secondBuyAmount);
  // How much ETH we get at the end with a potential profit
  let thirdAmountOut = await uniswap.getAmountOut(
    firstAmountOut,
    updatedReserveB2,
    updatedReserveA2
  );

  const deadline = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now
  let firstTransaction = {
    signer: signingWallet,
    transaction: await uniswap.populateTransaction.swapExactETHForTokens(
      firstAmountOut,
      [wethAddress, tokenToCapture],
      signingWallet.address,
      deadline,
      {
        value: buyAmount,
        type: 2,
        maxFeePerGas: maxGasFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: 300000,
      }
    ),
  };
  firstTransaction.transaction = {
    ...firstTransaction.transaction,
    chainId,
  };
  const victimsTransactionWithChainId = {
    chainId,
    ...transaction,
  };
  const signedMiddleTransaction = {
    signedTransaction: ethers.utils.serializeTransaction(
      victimsTransactionWithChainId,
      {
        r: victimsTransactionWithChainId.r,
        s: victimsTransactionWithChainId.s,
        v: victimsTransactionWithChainId.v,
      }
    ),
  };

  const erc20 = erc20Factory.attach(tokenToCapture);
  let thirdTransaction = {
    signer: signingWallet,
    transaction: await erc20.populateTransaction.approve(
      uniswapAddress,
      firstAmountOut,
      {
        value: '0',
        type: 2,
        maxFeePerGas: maxGasFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: 300000,
      }
    ),
  };
  thirdTransaction.transaction = {
    ...thirdTransaction.transaction,
    chainId,
  };

  let fourthTransaction = {
    signer: signingWallet,
    transaction: await uniswap.populateTransaction.swapExactTokensForETH(
      firstAmountOut,
      thirdAmountOut,
      [tokenToCapture, wethAddress],
      signingWallet.address,
      deadline,
      {
        value: '0',
        type: 2,
        maxFeePerGas: maxGasFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: 300000,
      }
    ),
  };
  fourthTransaction.transaction = {
    ...fourthTransaction.transaction,
    chainId,
  };

  const transactionsArray = [
    firstTransaction,
    signedMiddleTransaction,
    thirdTransaction,
    fourthTransaction,
  ];
  const signedTransactions = await flashbotsProvider.signBundle(
    transactionsArray
  );
  const blockNumber = await provider.getBlockNumber();
  console.log('Simulating...');
  const simulation = await flashbotsProvider.simulate(
    signedTransactions,
    blockNumber + 1
  );
  if (simulation.firstRevert) {
    return console.log('Simulation error', simulation.firstRevert);
  } else {
    console.log('Simulation success', simulation);
  }

  let bundleSubmission;
  flashbotsProvider
    .sendRawBundle(signedTransactions, blockNumber + 1)
    .then((_bundleSubmission) => {
      bundleSubmission = _bundleSubmission;
      console.log('Bundle submitted', bundleSubmission.bundleHash);
      return bundleSubmission.wait();
    })
    .then(async (waitResponse) => {
      console.log('Wait response', FlashbotsBundleResolution[waitResponse]);
      if (waitResponse == FlashbotsBundleResolution.BundleIncluded) {
        console.log('--------------------------------------');
        console.log('--------------------------------------');
        console.log('---------- Bundle Included -----------');
        console.log('--------------------------------------');
        console.log('--------------------------------------');
      } else if (
        waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh
      ) {
        console.log('The transaction has been confirmed alreay');
      } else {
        console.log('Bundle hash', bundleSubmission.bundleHash);
        try {
          console.log({
            bundleStats: await flashbotsProvider.getBundleStats(
              bundleSubmission.bundleHash,
              blockNumber + 1
            ),
            userStats: await flashbotsProvider.getUserStats(),
          });
        } catch (err) {
          return false;
        }
      }
    });
};

const start = async () => {
  flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    signingWallet,
    flashbotsUrl
  );
  console.log('Listening on transaction for the chain id', chainId);
  wsProvider.on('pending', (tx) => {
    // console.log('tx: ', tx);
    processTransaction(tx);
  });
};

start();
