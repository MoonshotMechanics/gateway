import { TokenInfo } from '@solana/spl-token-registry';
import { Solanaish } from '../../chains/solana/solana';
import { Jupiter } from './jupiter';
import {
  PriceRequest,
  TradeRequest,
  TradeResponse,
  EstimateGasResponse,
} from '../connector.requests';
import {
  HttpException,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE,
  SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE,
  PRICE_FAILED_ERROR_CODE,
  PRICE_FAILED_ERROR_MESSAGE,
  UNKNOWN_ERROR_ERROR_CODE,
  UNKNOWN_ERROR_MESSAGE,
  INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_CODE,
  INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_MESSAGE,
  INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_CODE,
  INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_MESSAGE,
} from '../../services/error-handler';
import { logger } from '../../services/logger';
import { Wallet } from '@coral-xyz/anchor';
import Decimal from 'decimal.js-light';
import { QuoteResponse } from '@jup-ag/api';
import { wrapResponse } from '../../services/response-wrapper';
import { DECIMAL_MULTIPLIER } from './jupiter';

export interface TradeInfo {
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  requestAmount: number;
  expectedPrice: number;
  expectedAmount: number;
  gasEstimate: EstimateGasResponse;
}

export async function getTradeInfo(
  solanaish: Solanaish,
  jupiter: Jupiter,
  baseAsset: string,
  quoteAsset: string,
  amount: number,
  tradeSide: string,
  allowedSlippage?: string,
): Promise<{ tradeInfo: TradeInfo; quote: QuoteResponse }> {
  console.log(`Getting trade info for ${baseAsset}-${quoteAsset}`);
  
  const baseToken: TokenInfo = solanaish.getTokenForSymbol(baseAsset);
  console.log('Base token:', baseToken);
  
  const quoteToken: TokenInfo = solanaish.getTokenForSymbol(quoteAsset);
  console.log('Quote token:', quoteToken);
  
  if (!baseToken) {
    throw new Error(`Base token ${baseAsset} not found in token list`);
  }
  if (!quoteToken) {
    throw new Error(`Quote token ${quoteAsset} not found in token list`);
  }

  const requestAmount = Math.floor(amount * DECIMAL_MULTIPLIER ** baseToken.decimals);
  console.log('Request amount:', requestAmount);

  let slippagePct = allowedSlippage 
    ? Number(allowedSlippage) 
    : jupiter.getSlippagePct();

  // Add safety check
  if (isNaN(slippagePct) || slippagePct <= 0) {
    const DEFAULT_SLIPPAGE = 1.0;  // 1%
    logger.warn(`Invalid slippage value ${slippagePct}, using default ${DEFAULT_SLIPPAGE}%`);
    slippagePct = DEFAULT_SLIPPAGE;
  }

  console.log('Slippage:', slippagePct);

  try {
    let quote: QuoteResponse;
    if (tradeSide === 'BUY') {
      console.log('Getting BUY quote...');
      quote = await jupiter.getQuote(
        quoteToken.symbol,
        baseToken.symbol,
        amount,
        slippagePct,
        false,
        false,
      );
    } else {
      console.log('Getting SELL quote...');
      quote = await jupiter.getQuote(
        baseToken.symbol,
        quoteToken.symbol,
        amount,
        slippagePct,
        false,
        false,
        'ExactIn'
      );
    }
    console.log('Quote received:', quote);

    const baseAmount = tradeSide === 'BUY'
      ? Number(quote.outAmount) / (10 ** baseToken.decimals)
      : Number(quote.inAmount) / (10 ** baseToken.decimals)
    const quoteAmount = tradeSide === 'BUY'
      ? Number(quote.inAmount) / (10 ** quoteToken.decimals)
      : Number(quote.outAmount) / (10 ** quoteToken.decimals)

    const expectedPrice = Number(quoteAmount) / Number(baseAmount);
    const expectedAmount = Number(quoteAmount);

    const gasEstimate = await estimateGas(solanaish, jupiter);

    return {
      tradeInfo: {
        baseToken,
        quoteToken,
        requestAmount,
        expectedPrice,
        expectedAmount,
        gasEstimate,
      },
      quote,
    };
  } catch (e) {
    if (e instanceof Error) {
      throw new HttpException(
        500,
        PRICE_FAILED_ERROR_MESSAGE + e.message,
        PRICE_FAILED_ERROR_CODE
      );
    } else {
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }
}

export async function price(
  solanaish: Solanaish,
  jupiter: Jupiter,
  req: PriceRequest,
) {
  const initTime = Date.now();
  
  let tradeInfo: TradeInfo;
  let quote: QuoteResponse;
  try {
    const result = await getTradeInfo(
      solanaish,
      jupiter,
      req.base,
      req.quote,
      Number(req.amount),
      req.side,
      req.allowedSlippage,
    );
    tradeInfo = result.tradeInfo;
    quote = result.quote;
  } catch (e) {
    if (e instanceof Error) {
      throw new HttpException(
        500,
        PRICE_FAILED_ERROR_MESSAGE + e.message,
        PRICE_FAILED_ERROR_CODE
      );
    } else {
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }

  const { baseToken, quoteToken, requestAmount, expectedPrice, expectedAmount, gasEstimate } = tradeInfo;

  return wrapResponse({
    network: solanaish.network,
    base: baseToken.address,
    quote: quoteToken.address,
    amount: new Decimal(req.amount).toFixed(baseToken.decimals),
    rawAmount: requestAmount.toString(),
    expectedAmount: expectedAmount.toString(),
    price: expectedPrice.toString(),
    gasPrice: gasEstimate.gasPrice,
    gasPriceToken: gasEstimate.gasPriceToken,
    gasLimit: gasEstimate.gasLimit,
    gasCost: gasEstimate.gasCost,
  }, initTime);
}

export async function trade(
  solanaish: Solanaish,
  jupiter: Jupiter,
  req: TradeRequest,
): Promise<TradeResponse> {
  const initTime = Date.now();
  
  const keypair = await solanaish.getWallet(req.address);
  const wallet = new Wallet(keypair as any);

  let tradeInfo: TradeInfo;
  let quote: QuoteResponse;
  try {
    const result = await getTradeInfo(
      solanaish,
      jupiter,
      req.base,
      req.quote,
      Number(req.amount),
      req.side,
      req.allowedSlippage,
    );
    tradeInfo = result.tradeInfo;
    quote = result.quote;
  } catch (e) {
    if (e instanceof Error) {
      throw new HttpException(
        500,
        PRICE_FAILED_ERROR_MESSAGE + e.message,
        PRICE_FAILED_ERROR_CODE
      );
    } else {
      throw new HttpException(
        500,
        UNKNOWN_ERROR_MESSAGE,
        UNKNOWN_ERROR_ERROR_CODE
      );
    }
  }
  
  const { baseToken, quoteToken, requestAmount, expectedPrice, expectedAmount, gasEstimate } = tradeInfo;

  // Check limit price conditions
  if (req.side === 'BUY') {
    if (req.limitPrice && new Decimal(expectedPrice).gt(new Decimal(req.limitPrice))) {
      logger.error('Swap price exceeded limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_MESSAGE(expectedPrice, req.limitPrice),
        SWAP_PRICE_EXCEEDS_LIMIT_PRICE_ERROR_CODE,
      );
    }
  } else {
    if (req.limitPrice && new Decimal(expectedPrice).lt(new Decimal(req.limitPrice))) {
      logger.error('Swap price lower than limit price.');
      throw new HttpException(
        500,
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_MESSAGE(expectedPrice, req.limitPrice),
        SWAP_PRICE_LOWER_THAN_LIMIT_PRICE_ERROR_CODE,
      );
    }
  }

  // Add balance check
  if (req.side === 'SELL') {
    const balance = await solanaish.getBalance(keypair, [baseToken.symbol]);
    if (new Decimal(balance[baseToken.symbol]).lt(new Decimal(req.amount))) {
      throw new HttpException(
        500,
        INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_MESSAGE,
        INSUFFICIENT_BASE_TOKEN_BALANCE_ERROR_CODE
      );
    }
  } else {
    const balance = await solanaish.getBalance(keypair, [quoteToken.symbol]);
    if (new Decimal(balance[quoteToken.symbol]).lt(new Decimal(expectedAmount))) {
      throw new HttpException(
        500,
        INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_MESSAGE,
        INSUFFICIENT_QUOTE_TOKEN_BALANCE_ERROR_CODE
      );
    }
  }

  // Execute swap with correct input/output tokens based on trade side
  const { 
    signature, 
    feeInLamports, 
    computeUnitLimit,
    priorityFeePrice 
  } = await jupiter.executeSwap(
    wallet,
    quote,
  );

  logger.info(`Swap confirmed: ${signature} - ${req.side} ${req.amount} ${baseToken.symbol} at ${expectedPrice} ${quoteToken.symbol}/${baseToken.symbol}`);

  const response = {
    network: solanaish.network,
    base: baseToken.address,
    quote: quoteToken.address,
    amount: new Decimal(req.amount).toFixed(baseToken.decimals),
    rawAmount: requestAmount.toString(),
    gasPrice: priorityFeePrice,
    gasPriceToken: gasEstimate.gasPriceToken,
    gasLimit: computeUnitLimit,
    gasCost: (feeInLamports / 1e9).toString(),
    txHash: signature,
    price: expectedPrice.toString(),
  };

  if (req.side === 'BUY') {
    return wrapResponse({
      ...response,
      expectedIn: expectedAmount.toString(),
    }, initTime);
  } else {
    return wrapResponse({
      ...response,
      expectedOut: expectedAmount.toString(),
    }, initTime);
  }
}

export async function estimateGas(
  solanaish: Solanaish,
  jupiter: Jupiter,
): Promise<EstimateGasResponse> {
  const initTime = Date.now();
  
  const priorityFeeInMicroLamports = await solanaish.estimatePriorityFees(
    solanaish.connectionPool.getNextConnection().rpcEndpoint
  );
  
  const gasCost = await solanaish.getGasPrice();

  return wrapResponse({
    network: solanaish.network,
    gasPrice: priorityFeeInMicroLamports,
    gasPriceToken: solanaish.nativeTokenSymbol,
    gasLimit: solanaish.defaultComputeUnits,
    gasCost: gasCost.toString(),
  }, initTime);
}
