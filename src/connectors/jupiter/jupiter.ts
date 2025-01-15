import { Solana } from '../../chains/solana/solana';
import { VersionedTransaction } from '@solana/web3.js';
import { 
  QuoteGetRequest, 
  QuoteResponse, 
  SwapResponse, 
  createJupiterApiClient,
} from '@jup-ag/api';
import { JupiterConfig } from './jupiter.config';
import { percentRegexp } from '../../services/config-manager-v2';
import { Wallet } from '@coral-xyz/anchor';
import { logger } from '../../services/logger';
import { BASE_FEE } from '../../chains/solana/solana';
import { 
  HttpException,
  SIMULATION_ERROR_CODE,
  SIMULATION_ERROR_MESSAGE,
  SWAP_ROUTE_FETCH_ERROR_CODE,
  SWAP_ROUTE_FETCH_ERROR_MESSAGE,
} from '../../services/error-handler';

const JUPITER_API_RETRY_COUNT = 5;
const JUPITER_API_RETRY_INTERVAL_MS = 1000;
export const DECIMAL_MULTIPLIER = 10;

export class Jupiter {
  private static _instances: { [name: string]: Jupiter };
  private chain: Solana;
  private _ready: boolean = false;
  private _config: JupiterConfig.NetworkConfig;
  protected jupiterQuoteApi!: ReturnType<typeof createJupiterApiClient>;

  private constructor(network: string) {
    this._config = JupiterConfig.config;
    this.chain = Solana.getInstance(network);
    this.loadJupiter();
  }

  protected async loadJupiter(): Promise<void> {
    try {
      if (!this.jupiterQuoteApi) {
        this.jupiterQuoteApi = createJupiterApiClient();
        
      }
    } catch (error) {
      logger.error("Failed to initialize Jupiter:", error);
      throw error;
    }
  }

  public static getInstance(network: string): Jupiter {
    if (Jupiter._instances === undefined) {
      Jupiter._instances = {};
    }
    if (!(network in Jupiter._instances)) {
      Jupiter._instances[network] = new Jupiter(network);
    }

    return Jupiter._instances[network];
  }

  public async init() {
    if (!this.chain.ready()) {
      await this.chain.init();
    }
    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  getSlippagePct(): number {
    const DEFAULT_SLIPPAGE = 1.0; // 1%
    const allowedSlippage = this._config.allowedSlippage;
    const nd = allowedSlippage.match(percentRegexp);
    let slippage = 0.0;
    if (nd) {
        slippage = Number(nd[1]) / Number(nd[2]);
    } else {
        logger.error('Failed to parse slippage value:', allowedSlippage);
        return DEFAULT_SLIPPAGE;
    }
    return slippage * 100;
  }

  async getQuote(
    inputTokenSymbol: string,
    outputTokenSymbol: string,
    amount: number,
    slippagePct?: number,
    onlyDirectRoutes: boolean = false,
    asLegacyTransaction: boolean = false,
    swapMode: 'ExactIn' | 'ExactOut' = 'ExactIn',
  ): Promise<QuoteResponse> {
    await this.loadJupiter();

    const inputToken = this.chain.getTokenForSymbol(inputTokenSymbol);
    const outputToken = this.chain.getTokenForSymbol(outputTokenSymbol);

    if (!inputToken || !outputToken) {
      logger.error('Invalid token symbols');
      throw new Error('Invalid token symbols');
    }

    const slippageBps = slippagePct ? Math.round(slippagePct * 100) : 0;
    const tokenDecimals = swapMode === 'ExactOut' ? outputToken.decimals : inputToken.decimals;
    const quoteAmount = Math.floor(amount * 10 ** tokenDecimals);

    const params: QuoteGetRequest = {
      inputMint: inputToken.address,
      outputMint: outputToken.address,
      amount: quoteAmount,
      slippageBps,
      onlyDirectRoutes,
      asLegacyTransaction,
      swapMode,
    };

    console.log('Requesting Jupiter quote with params:', params);

    try {
      const quote = await this.jupiterQuoteApi.quoteGet(params);
      console.log('Jupiter quote response:', quote);

      if (!quote) {
        logger.error('Unable to get quote');
        throw new Error('Unable to get quote');
      }

      return quote;
    } catch (error) {
      console.error('Jupiter API error:', error.response?.data || error);
      throw error;
    }
  }

  async getSwapObj(wallet: Wallet, quote: QuoteResponse, priorityFee?: number): Promise<SwapResponse> {
    const prioritizationFeeLamports = priorityFee 
      ? priorityFee  
      : this.chain.minPriorityFee;

    logger.info(`Sending swap with priority fee: ${priorityFee / 1e9} SOL`);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= JUPITER_API_RETRY_COUNT; attempt++) {
      try {
        const swapObj = await this.jupiterQuoteApi.swapPost({
          swapRequest: {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports,
          },
        });
        return swapObj;
      } catch (error) {
        lastError = error;
        logger.error(`Jupiter API swapPost attempt ${attempt}/${JUPITER_API_RETRY_COUNT} failed:`, 
          error.response?.status ? {
            error: error.message,
            status: error.response.status,
            data: error.response.data
          } : error
        );

        if (attempt < JUPITER_API_RETRY_COUNT) {
          logger.info(`Waiting ${JUPITER_API_RETRY_INTERVAL_MS}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, JUPITER_API_RETRY_INTERVAL_MS));
        }
      }
    }

    throw new HttpException(
      503,
      SWAP_ROUTE_FETCH_ERROR_MESSAGE + `Failed after ${JUPITER_API_RETRY_COUNT} attempts. Last error: ${lastError?.message}`,
      SWAP_ROUTE_FETCH_ERROR_CODE
    );
  }

  async simulateTransaction(transaction: VersionedTransaction) {
    const { value: simulatedTransactionResponse } = await this.chain.connectionPool.getNextConnection().simulateTransaction(
      transaction,
      {
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [] },
        sigVerify: false,
      },
    );
    
    if (simulatedTransactionResponse.err) {
      const logs = simulatedTransactionResponse.logs || [];
      logger.error('Simulation Error Details:', {
        error: simulatedTransactionResponse.err,
        programLogs: logs,
        accounts: simulatedTransactionResponse.accounts,
        unitsConsumed: simulatedTransactionResponse.unitsConsumed,
      });

      const errorMessage = `${SIMULATION_ERROR_MESSAGE}\nError: ${JSON.stringify(simulatedTransactionResponse.err)}\nProgram Logs: ${logs.join('\n')}`;
      
      throw new HttpException(
        503,
        errorMessage,
        SIMULATION_ERROR_CODE
      );
    }
  }

  async executeSwap(
    wallet: Wallet,
    quote: QuoteResponse,
  ): Promise<{ 
    signature: string; 
    feeInLamports: number;
    computeUnitLimit: number;
    priorityFeePrice: number;
  }> {
    await this.loadJupiter();
    let currentPriorityFee = (await this.chain.getGasPrice() * 1e9) - BASE_FEE;

    while (currentPriorityFee <= this.chain.maxPriorityFee) {
      const swapObj = await this.getSwapObj(wallet, quote, currentPriorityFee);

      const swapTransactionBuf = Buffer.from(swapObj.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(new Uint8Array(swapTransactionBuf));
      await this.simulateTransaction(transaction);
      transaction.sign([wallet.payer]);

      let retryCount = 0;
      while (retryCount < this.chain.retryCount) {
        try {
          const signature = await this.chain.sendRawTransaction(
            Buffer.from(transaction.serialize()),
            swapObj.lastValidBlockHeight,
          );

          for (const connection of this.chain.connectionPool.getAllConnections()) {
            try {
              const { confirmed, txData } = await this.chain.confirmTransaction(signature, connection);
              if (confirmed && txData) {
                const computeUnitsUsed = txData.meta.computeUnitsConsumed;
                const totalFee = txData.meta.fee;
                const priorityFee = totalFee - BASE_FEE;
                const priorityFeePrice = (priorityFee / computeUnitsUsed) * 1e6; // microlamports per CU

                return {
                  signature,
                  feeInLamports: totalFee,
                  computeUnitLimit: computeUnitsUsed,
                  priorityFeePrice,
                };
              }
            } catch (error) {
              logger.error(`Swap confirmation attempt failed: ${error.message}`);
            }
          }

          retryCount++;
          await new Promise(resolve => setTimeout(resolve, this.chain.retryIntervalMs));
        } catch (error) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, this.chain.retryIntervalMs));
        }
      }

      // If we get here, swap wasn't confirmed after retryCount attempts
      // Increase the priority fee and try again
      currentPriorityFee = Math.floor(currentPriorityFee * this.chain.priorityFeeMultiplier);
      logger.info(`Increasing priority fee to ${currentPriorityFee / 1e9} SOL`);
    }

    throw new Error(`Swap failed after reaching maximum priority fee of ${this.chain.maxPriorityFee / 1e9} SOL`);
  }

  async extractSwapBalances(
    signature: string,
    inputMint: string,
    outputMint: string,
  ): Promise<{
    totalInputSwapped: number;
    totalOutputSwapped: number;
    fee: number;
  }> {
    let inputBalanceChange: number, outputBalanceChange: number, fee: number;

    // Get transaction info to extract the 'from' address
    const txInfo = await this.chain.connectionPool.getNextConnection().getTransaction(signature);
    if (!txInfo) {
        throw new Error('Transaction not found');
    }
    const fromAddress = txInfo.transaction.message.accountKeys[0].toBase58();

    if (inputMint === 'So11111111111111111111111111111111111111112') {
        ({ balanceChange: inputBalanceChange, fee } = await this.chain.extractAccountBalanceChangeAndFee(
            signature,
            0,
        ));
    } else {
        ({ balanceChange: inputBalanceChange, fee } = await this.chain.extractTokenBalanceChangeAndFee(
            signature,
            inputMint,
            fromAddress,
        ));
    }

    if (outputMint === 'So11111111111111111111111111111111111111112') {
        ({ balanceChange: outputBalanceChange } = await this.chain.extractAccountBalanceChangeAndFee(
            signature,
            0,
        ));
    } else {
        ({ balanceChange: outputBalanceChange } = await this.chain.extractTokenBalanceChangeAndFee(
            signature,
            outputMint,
            fromAddress,
        ));
    }

    return {
        totalInputSwapped: Math.abs(inputBalanceChange),
        totalOutputSwapped: Math.abs(outputBalanceChange),
        fee,
    };
  }

  public static getRequestAmount(amount: number, decimals: number): number {
    return Math.floor(amount * DECIMAL_MULTIPLIER ** decimals);
  }

}