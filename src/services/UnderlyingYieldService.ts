import { Provider } from '@ethersproject/providers';
import { BigNumber, Contract } from 'ethers';
import { formatUnits } from 'ethers/lib/utils';

export interface UnderlyingAPYs {
  [key: string]: number | null;
}

const DAY_IN_SECONDS = 60 * 60 * 24;
const YEAR_IN_SECONDS = 365 * DAY_IN_SECONDS;

const RAY_PRECISION = 27;
// const RAY = BigNumber.from(10).pow(RAY_PRECISION);
const WAD_PRECISION = 18;
const WAD = BigNumber.from(10).pow(WAD_PRECISION);

export class UnderlyingYieldService {
  constructor(private readonly getProvider: (chainId: number) => Provider) {}

  async getUnderlyingAPYs(): Promise<UnderlyingAPYs> {
    const stethAPY = await this.getStethAPY();
    console.log('stethAPY', stethAPY);
    const sdaiAPY = await this.getSdaiAPY();
    return {
      wstETH: stethAPY,
      sDAI: sdaiAPY,
    };
  }

  getStethAPY = async () => {
    // computation formula: https://docs.lido.fi/integrations/api#last-lido-apr-for-steth
    const computeStethAPY = ({
      preTotalEther,
      preTotalShares,
      postTotalEther,
      postTotalShares,
      timeElapsed,
    }: {
      preTotalEther: BigNumber;
      preTotalShares: BigNumber;
      postTotalEther: BigNumber;
      postTotalShares: BigNumber;
      timeElapsed: BigNumber;
    }) => {
      const secondsInYear = BigNumber.from(YEAR_IN_SECONDS);

      const preShareRate = preTotalEther.mul(BigNumber.from(10).pow(27)).div(preTotalShares);
      const postShareRate = postTotalEther.mul(BigNumber.from(10).pow(27)).div(postTotalShares);

      // need to mul by 10e18 because otherwise the division will be 0 (since the result is less than 1)
      const pendingApr = secondsInYear
        .mul(postShareRate.sub(preShareRate).mul(WAD).div(preShareRate))
        .div(timeElapsed);

      // then format to 18 decimals
      const apr = formatUnits(pendingApr, WAD_PRECISION);

      // stEth rebased daily: https://help.lido.fi/en/articles/5230610-what-is-steth
      const apy = (1 + Number(apr) / 365) ** 365 - 1;

      return apy;
    };

    const abi = [
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'reportTimestamp', type: 'uint256' },
          { indexed: false, name: 'timeElapsed', type: 'uint256' },
          { indexed: false, name: 'preTotalShares', type: 'uint256' },
          { indexed: false, name: 'preTotalEther', type: 'uint256' },
          { indexed: false, name: 'postTotalShares', type: 'uint256' },
          { indexed: false, name: 'postTotalEther', type: 'uint256' },
          { indexed: false, name: 'sharesMintedAsFees', type: 'uint256' },
        ],
        name: 'TokenRebased',
        type: 'event',
      },
    ];

    const provider = this.getProvider(1);
    const contract = new Contract('0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', abi);
    const connectedContract = contract.connect(provider);

    const currentBlockNumber = await provider.getBlockNumber();
    const blocksInDay = DAY_IN_SECONDS / 12;

    const events = await connectedContract.queryFilter(
      connectedContract.filters.TokenRebased(),
      currentBlockNumber - blocksInDay * 7, // ~1 week
      currentBlockNumber
    );

    const latestEvent = events.length === 0 ? null : events[events.length - 1];

    if (!latestEvent || !latestEvent.args) {
      // in case there are no events in the last week
      const res = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/last');
      const resParsed: {
        data: {
          timeUnix: number;
          apr: number;
        };
        meta: {
          symbol: string;
          address: string;
          chainId: number;
        };
      } = await res.json();
      // data.apr is the apy
      return resParsed.data.apr;
    } else {
      return computeStethAPY({
        preTotalEther: latestEvent.args['preTotalEther'],
        preTotalShares: latestEvent.args['preTotalShares'],
        postTotalEther: latestEvent.args['postTotalEther'],
        postTotalShares: latestEvent.args['postTotalShares'],
        timeElapsed: latestEvent.args['timeElapsed'],
      });
    }
  };

  getSdaiAPY = async () => {
    const abi = [
      {
        constant: true,
        inputs: [],
        name: 'dsr',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
    ];

    const provider = this.getProvider(1);
    const contract = new Contract('0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7', abi);
    const connectedContract = contract.connect(provider);

    const dsr = await connectedContract.dsr();

    const dsrFormated = formatUnits(dsr, RAY_PRECISION);

    // Inspired from DeFi LLama yield server: https://github.com/DefiLlama/yield-server/blob/master/src/adaptors/makerdao/index.js
    const apy = Number(dsrFormated) ** YEAR_IN_SECONDS - 1;

    return apy;
  };
}
