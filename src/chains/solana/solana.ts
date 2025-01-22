import crypto from 'crypto';
import bs58 from 'bs58';
import { BigNumber } from 'ethers';
import fse from 'fs-extra';

import { TokenInfo, TokenListContainer } from '@solana/spl-token-registry';
import {
  AccountInfo,
  Connection,
  Keypair,
  ParsedAccountData,
  PublicKey,
  ComputeBudgetProgram,
  Signer,
  Transaction,
  TokenAmount,
  TransactionResponse,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import { Client, UtlConfig, Token } from '@solflare-wallet/utl-sdk';
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

import { countDecimals, TokenValue, walletPath } from '../../services/base';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { logger } from '../../services/logger';
import { TokenListResolutionStrategy } from '../../services/token-list-resolution';
import { Config, getSolanaConfig } from './solana.config';
import { TransactionResponseStatusCode } from './solana.requests';
import { SolanaController } from './solana.controllers';

// Constants used for fee calculations
export const BASE_FEE = 5000;
const TOKEN_PROGRAM_ADDRESS = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const LAMPORT_TO_SOL = 1 / Math.pow(10, 9);

// Add accounts from https://triton.one/solana-prioritization-fees/ to track general fees
const PRIORITY_FEE_ACCOUNTS = [
  '4qGj88CX3McdTXEviEaqeP2pnZJxRTsZFWyU3Mrnbku4',
  '2oLNTQKRb4a2117kFi6BYTUDu3RPrMVAHFhCfPKMosxX',
  'xKUz6fZ79SXnjGYaYhhYTYQBoRUBoCyuDMkBa1tL3zU',
  'GASeo1wEK3Rwep6fsAt212Jw9zAYguDY5qUwTnyZ4RH',
  'B8emFMG91JJsBELV4XVkTNe3YTs85x4nCqub7dRZUY1p',
  'DteH7aNKykAG2b2KQo7DD9XvLBfNgAuf2ixj5HC7ppTk',
  '5HngGmYzvSuh3XyU11brHDpMTHXQQRQQT4udGFtQSjgR',
  'GD37bnQdGkDsjNqnVGr9qWTnQJSKMHbsiXX9tXLMUcaL',
  '4po3YMfioHkNP4mL4N46UWJvBoQDS2HFjzGm1ifrUWuZ',
  '5veMSa4ks66zydSaKSPMhV7H2eF88HvuKDArScNH9jaG',
];

interface PriorityFeeResponse {
  jsonrpc: string;
  result: Array<{
    prioritizationFee: number;
    slot: number;
  }>;
  id: number;
}

class ConnectionPool {
  private connections: Connection[] = [];
  private currentIndex: number = 0;

  constructor(urls: string[]) {
    this.connections = urls.map((url) => new Connection(url, { commitment: 'confirmed' }));
  }

  public getNextConnection(): Connection {
    const connection = this.connections[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    return connection;
  }

  public getAllConnections(): Connection[] {
    return this.connections;
  }
}

export class Solana implements Solanaish {
  public defaultComputeUnits;
  public priorityFeePercentile;
  public priorityFeeMultiplier;
  public maxPriorityFee;
  public minPriorityFee;
  public retryIntervalMs;
  public retryCount;
  public connectionPool: ConnectionPool;
  public network: string;
  public nativeTokenSymbol: string;
  public rpcUrl: string;

  protected tokenList: TokenInfo[] = [];
  private _config: Config;
  private _tokenMap: Record<string, TokenInfo> = {};
  private _tokenAddressMap: Record<string, TokenInfo> = {};
  private _utl: Client;

  private static _instances: { [name: string]: Solana };

  public readonly lamportDecimals: number;

  // there are async values set in the constructor
  private _ready: boolean = false;
  private initializing: boolean = false;
  public controller: typeof SolanaController;

  private static lastPriorityFeeEstimate: {
    timestamp: number;
    fee: number;
  } | null = null;
  private static PRIORITY_FEE_CACHE_MS = 10000; // 10 second cache

  constructor(network: string) {
    this.network = network;
    this._config = getSolanaConfig('solana', network);
    console.log("Initializing Solana with config:", {
        network: this.network,
        tokenListSource: this._config.network.tokenListSource,
        tokenListType: this._config.network.tokenListType
    });
    
    // Add detailed logging for token list source
    try {
        const fs = require('fs');
        if (fs.existsSync(this._config.network.tokenListSource)) {
            const tokenList = JSON.parse(fs.readFileSync(this._config.network.tokenListSource, 'utf8'));
            console.log("First token in source file:", tokenList[0]);
            console.log("Total tokens in source file:", tokenList.length);
        } else {
            console.log("Token list file not found at:", this._config.network.tokenListSource);
            console.log("Current working directory:", process.cwd());
        }
    } catch (error) {
        console.log("Error reading token list source:", error.message);
    }
    
    this.nativeTokenSymbol = this._config.network.nativeCurrencySymbol
    this.defaultComputeUnits = this._config.defaultComputeUnits;
    this.priorityFeePercentile = this._config.priorityFeePercentile;
    this.priorityFeeMultiplier = this._config.priorityFeeMultiplier;
    this.maxPriorityFee = this._config.maxPriorityFee;
    this.minPriorityFee = this._config.minPriorityFee;
    this.retryIntervalMs = this._config.retryIntervalMs;
    this.retryCount = this._config.retryCount;

    // Parse comma-separated RPC URLs
    this.rpcUrl = this._config.network.nodeURL;
    
    this.connectionPool = new ConnectionPool([this.rpcUrl]);
    this.lamportDecimals = countDecimals(LAMPORT_TO_SOL);

    this.controller = SolanaController;

    // Initialize UTL client
    const config = new UtlConfig({
      chainId: this.network === 'devnet' ? 103 : 101,
      timeout: 2000,
      connection: this.connectionPool.getNextConnection(),
      apiUrl: 'https://token-list-api.solana.cloud',
      cdnUrl: 'https://cdn.jsdelivr.net/gh/solflare-wallet/token-list/solana-tokenlist.json',
    });
    this._utl = new Client(config);

    // Initialize but don't load tokens yet
    this._ready = false;
    this.initializing = false;
  }

  public static getInstance(network: string): Solana {
    if (Solana._instances === undefined) {
      Solana._instances = {};
    }
    if (!(network in Solana._instances)) {
      Solana._instances[network] = new Solana(network);
    }

    return Solana._instances[network];
  }

  public static getConnectedInstances(): { [name: string]: Solana } {
    return this._instances;
  }

  async init(): Promise<void> {
    console.log("Initializing Solana instance...");
    if (!this.ready() && !this.initializing) {
      try {
        this.initializing = true;
        
        // Load tokens
        await this.loadTokens();
        
        // Set ready state
        this._ready = true;
        console.log("Solana instance initialized successfully");
      } catch (error) {
        console.error(`Failed to initialize Solana instance: ${error.message}`);
        throw error;
      } finally {
        this.initializing = false;
      }
    }
  }

  ready(): boolean {
    return this._ready;
  }

  public async getTokenByAddress(tokenAddress: string, useApi: boolean = false): Promise<Token> {
    if (useApi && this.network !== 'mainnet-beta') {
      throw new Error('API usage is only allowed on mainnet-beta');
    }

    const publicKey = new PublicKey(tokenAddress);
    let token: Token;

    if (useApi) {
      token = await this._utl.fetchMint(publicKey);
    } else {
      const tokenList = await this.getTokenList();
      const foundToken = tokenList.find((t) => t.address === tokenAddress);
      if (!foundToken) {
        throw new Error('Token not found in the token list');
      }
      token = foundToken as unknown as Token;
    }

    return token;
  }


  async loadTokens(): Promise<void> {
    console.log("Loading tokens...");
    this.tokenList = await this.getTokenList();
    console.log(`Loaded ${this.tokenList.length} tokens`);
    
    // Debug token map before population
    console.log("Token map before:", Object.keys(this._tokenMap).length);
    
    this.tokenList.forEach((token: TokenInfo) => {
      // Store tokens with original case
      this._tokenMap[token.symbol] = token;
      this._tokenAddressMap[token.address] = token;
      
      if (token.symbol === 'AI16Z') {
        console.log('Found AI16Z token during loading:', token);
      }
    });
    
    // Debug final state
    console.log("Token map after:", Object.keys(this._tokenMap).length);
    console.log("AI16Z lookup test:", this._tokenMap['AI16Z']);
    console.log("First few tokens:", Object.keys(this._tokenMap).slice(0, 5));
  }

  // returns a Tokens for a given list source and list type
  async getTokenList(): Promise<TokenInfo[]> {
    const tokens: TokenInfo[] =
      await new TokenListResolutionStrategy(
        this._config.network.tokenListSource,
        this._config.network.tokenListType
      ).resolve();

    console.log("Pre-filter tokens:", tokens.length);
    console.log("First token pre-filter:", tokens[0]);
    
    const tokenListContainer = new TokenListContainer(tokens);
    const filteredList = tokenListContainer.filterByClusterSlug(this.network).getList();
    
    console.log("Post-filter tokens:", filteredList.length);
    console.log("First token post-filter:", filteredList[0]);
    
    return filteredList;
  }

  // solana token lists are large. instead of reloading each time with
  // getTokenList, we can read the stored tokenList value from when the
  // object was initiated.
  public get storedTokenList(): TokenInfo[] {
    return Object.values(this._tokenMap);
  }

  // return the TokenInfo object for a symbol
  getTokenForSymbol(symbol: string): TokenInfo | null {
    if (!this._ready) {
      console.log("Warning: Trying to get token before initialization");
      throw new Error("Solana instance not initialized");
    }
    
    console.log(`Looking up token symbol: "${symbol}"`);
    const token = this._tokenMap[symbol];
    console.log(`Found token:`, token);
    return token ?? null;
  }

  // returns Keypair for a private key, which should be encoded in Base58
  getKeypairFromPrivateKey(privateKey: string): Keypair {
    const decoded = bs58.decode(privateKey);
    return Keypair.fromSecretKey(new Uint8Array(decoded));
  }

  async getWallet(address: string): Promise<Keypair> {
    const path = `${walletPath}/solana`;

    const encryptedPrivateKey: string = await fse.readFile(
      `${path}/${address}.json`,
      'utf8'
    );

    const passphrase = ConfigManagerCertPassphrase.readPassphrase();
    if (!passphrase) {
      throw new Error('missing passphrase');
    }
    const decrypted = await this.decrypt(encryptedPrivateKey, passphrase);

    return Keypair.fromSecretKey(new Uint8Array(bs58.decode(decrypted)));
  }

  async encrypt(secret: string, password: string): Promise<string> {
    const algorithm = 'aes-256-ctr';
    const iv = crypto.randomBytes(16);
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, new Uint8Array(salt), 5000, 32, 'sha512');
    const cipher = crypto.createCipheriv(algorithm, new Uint8Array(key), new Uint8Array(iv));
    
    const encryptedBuffers = [
      new Uint8Array(cipher.update(new Uint8Array(Buffer.from(secret)))),
      new Uint8Array(cipher.final())
    ];
    const encrypted = Buffer.concat(encryptedBuffers);

    const ivJSON = iv.toJSON();
    const saltJSON = salt.toJSON();
    const encryptedJSON = encrypted.toJSON();

    return JSON.stringify({
      algorithm,
      iv: ivJSON,
      salt: saltJSON,
      encrypted: encryptedJSON,
    });
  }

  async decrypt(encryptedSecret: string, password: string): Promise<string> {
    const hash = JSON.parse(encryptedSecret);
    const salt = new Uint8Array(Buffer.from(hash.salt, 'utf8'));
    const iv = new Uint8Array(Buffer.from(hash.iv, 'utf8'));

    const key = crypto.pbkdf2Sync(password, salt, 5000, 32, 'sha512');

    const decipher = crypto.createDecipheriv(
      hash.algorithm, 
      new Uint8Array(key), 
      iv
    );

    const decryptedBuffers = [
      new Uint8Array(decipher.update(new Uint8Array(Buffer.from(hash.encrypted, 'hex')))),
      new Uint8Array(decipher.final())
    ];
    const decrypted = Buffer.concat(decryptedBuffers);

    return decrypted.toString();
  }

  async getBalance(wallet: Keypair, symbols?: string[]): Promise<Record<string, number>> {
    // Convert symbols to uppercase for case-insensitive matching
    const upperCaseSymbols = symbols?.map(s => s.toUpperCase());
    const publicKey = wallet.publicKey;
    let balances: Record<string, number> = {};

    // Fetch SOL balance only if symbols is undefined or includes "SOL" (case-insensitive)
    if (!upperCaseSymbols || upperCaseSymbols.includes("SOL")) {
      const solBalance = await this.connectionPool.getNextConnection().getBalance(publicKey);
      const solBalanceInSol = solBalance / Math.pow(10, 9); // Convert lamports to SOL
      balances["SOL"] = solBalanceInSol;
    }

    // Get all token accounts for the provided address
    const accounts = await this.connectionPool.getNextConnection().getTokenAccountsByOwner(
      publicKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    // Fetch the token list and create lookup map
    const tokenList = await this.getTokenList();
    const tokenDefs = tokenList.reduce((acc, token) => {
      if (!upperCaseSymbols || upperCaseSymbols.includes(token.symbol.toUpperCase())) {
        acc[token.address] = { symbol: token.symbol, decimals: token.decimals };
      }
      return acc;
    }, {});

    // Process token accounts
    for (const value of accounts.value) {
      const parsedTokenAccount = unpackAccount(value.pubkey, value.account);
      const mint = parsedTokenAccount.mint;
      const tokenDef = tokenDefs[mint.toBase58()];
      if (tokenDef === undefined) continue;

      const amount = parsedTokenAccount.amount;
      const uiAmount = Number(amount) / Math.pow(10, tokenDef.decimals);
      balances[tokenDef.symbol] = uiAmount;
    }

    return balances;
  }

  async getBalances(wallet: Keypair): Promise<Record<string, TokenValue>> {
    let balances: Record<string, TokenValue> = {};

    balances['UNWRAPPED_SOL'] = await this.getSolBalance(wallet);

    const allSplTokens = await this.connectionPool.getNextConnection().getParsedTokenAccountsByOwner(
      wallet.publicKey, 
      { programId: TOKEN_PROGRAM_ADDRESS }
    );

    allSplTokens.value.forEach(
      (tokenAccount: {
        pubkey: PublicKey;
        account: AccountInfo<ParsedAccountData>;
      }) => {
        const tokenInfo = tokenAccount.account.data.parsed['info'];
        const symbol = this.getTokenForMintAddress(tokenInfo['mint'])?.symbol;
        if (symbol != null)
          balances[symbol] = this.tokenResponseToTokenValue(
            tokenInfo['tokenAmount']
          );
      }
    );

    let allSolBalance = BigNumber.from(0);
    let allSolDecimals = 9; // Solana's default decimals

    if (balances['UNWRAPPED_SOL'] && balances['UNWRAPPED_SOL'].value) {
      allSolBalance = allSolBalance.add(balances['UNWRAPPED_SOL'].value);
      allSolDecimals = balances['UNWRAPPED_SOL'].decimals;
    }

    if (balances['SOL'] && balances['SOL'].value) {
      allSolBalance = allSolBalance.add(balances['SOL'].value);
      allSolDecimals = balances['SOL'].decimals;
    } else {
      balances['SOL'] = {
        value: allSolBalance,
        decimals: allSolDecimals,
      };
    }

    balances['ALL_SOL'] = {
      value: allSolBalance,
      decimals: allSolDecimals,
    };

    balances = Object.keys(balances)
      .sort((key1: string, key2: string) =>
        key1.toUpperCase().localeCompare(key2.toUpperCase())
      )
      .reduce((target: Record<string, TokenValue>, key) => {
        target[key] = balances[key];
        return target;
      }, {});

    return balances;
  }

  // returns the SOL balance, convert BigNumber to string
  async getSolBalance(wallet: Keypair): Promise<TokenValue> {
    const lamports = await this.connectionPool.getNextConnection().getBalance(wallet.publicKey);
    return { value: BigNumber.from(lamports), decimals: this.lamportDecimals };
  }

  tokenResponseToTokenValue(account: TokenAmount): TokenValue {
    return {
      value: BigNumber.from(account.amount),
      decimals: account.decimals,
    };
  }

  // returns the balance for an SPL token
  public async getSplBalance(
    walletAddress: PublicKey,
    mintAddress: PublicKey
  ): Promise<TokenValue> {
    const response = await this.connectionPool.getNextConnection().getParsedTokenAccountsByOwner(
      walletAddress,
      { mint: mintAddress }
    );
    if (response['value'].length == 0) {
      throw new Error(`Token account not initialized`);
    }
    return this.tokenResponseToTokenValue(
      response.value[0].account.data.parsed['info']['tokenAmount']
    );
  }

  // returns whether the token account is initialized, given its mint address
  async isTokenAccountInitialized(
    walletAddress: PublicKey,
    mintAddress: PublicKey
  ): Promise<boolean> {
    const response = await this.connectionPool.getNextConnection().getParsedTokenAccountsByOwner(
      walletAddress,
      { programId: TOKEN_PROGRAM_ADDRESS }
    );
    for (const accountInfo of response.value) {
      if (
        accountInfo.account.data.parsed['info']['mint'] ==
        mintAddress.toBase58()
      )
        return true;
    }
    return false;
  }


  // returns a Solana TransactionResponse for a txHash.
  async getTransaction(
    payerSignature: string
  ): Promise<VersionedTransactionResponse | null> {
    const fetchedTx = this.connectionPool.getNextConnection().getTransaction(
      payerSignature,
      {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }
    );

    return fetchedTx;
  }

  // returns a Solana TransactionResponseStatusCode for a txData.
  public async getTransactionStatusCode(
    txData: TransactionResponse | null
  ): Promise<TransactionResponseStatusCode> {
    let txStatus;
    if (!txData) {
        // tx not yet confirmed by validator
        txStatus = TransactionResponseStatusCode.UNCONFIRMED;
    } else {
        // If txData exists, check if there's an error in the metadata
        txStatus =
            txData.meta?.err == null
                ? TransactionResponseStatusCode.CONFIRMED
                : TransactionResponseStatusCode.FAILED;
    }
    return txStatus;
  }

  public getTokenBySymbol(tokenSymbol: string): TokenInfo | undefined {
    // Start from the end of the list and work backwards
    for (let i = this.tokenList.length - 1; i >= 0; i--) {
      if (this.tokenList[i].symbol.toUpperCase() === tokenSymbol.toUpperCase()) {
        return this.tokenList[i];
      }
    }
    return undefined;
  }

  // return the TokenInfo object for a symbol
  private getTokenForMintAddress(mintAddress: PublicKey): TokenInfo | null {
    return this._tokenAddressMap[mintAddress.toString()]
      ? this._tokenAddressMap[mintAddress.toString()]
      : null;
  }

  // returns the current block number
  async getCurrentBlockNumber(): Promise<number> {
    return await this.connectionPool.getNextConnection().getSlot('processed');
  }

  async close() {
    if (this.network in Solana._instances) {
      delete Solana._instances[this.network];
    }
  }

  public async getGasPrice(): Promise<number> {
    const priorityFeeInMicroLamports = await this.estimatePriorityFees(
      this.connectionPool.getNextConnection().rpcEndpoint
    );
    
    const BASE_FEE_LAMPORTS = 5000;
    const LAMPORTS_PER_SOL = Math.pow(10, 9);
    
    // Calculate priority fee in lamports
    const priorityFeeLamports = Math.floor(
      (this.defaultComputeUnits * priorityFeeInMicroLamports) / 1_000_000
    );
    
    // Add base fee and convert to SOL
    const gasCost = (BASE_FEE_LAMPORTS + priorityFeeLamports) / LAMPORTS_PER_SOL;

    return gasCost;
  }
  
  async estimatePriorityFees(rcpURL: string): Promise<number> {
    // Check cache first
    if (
      Solana.lastPriorityFeeEstimate && 
      Date.now() - Solana.lastPriorityFeeEstimate.timestamp < Solana.PRIORITY_FEE_CACHE_MS
    ) {
      return Solana.lastPriorityFeeEstimate.fee;
    }

    try {
      const params: string[][] = [];
      params.push(PRIORITY_FEE_ACCOUNTS);
      const payload = {
        method: 'getRecentPrioritizationFees',
        params: params,
        id: 1,
        jsonrpc: '2.0',
      };

      const response = await fetch(rcpURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch fees: ${response.status}`);
      }

      const data: PriorityFeeResponse = await response.json();

      // Extract fees and filter out zeros
      const fees = data.result
        .map((item) => item.prioritizationFee)
        .filter((fee) => fee > 0);

      // minimum fee is the minimum fee per compute unit
      const minimumFee = this.minPriorityFee / this.defaultComputeUnits * 1_000_000;

      if (fees.length === 0) {
        return minimumFee;
      }

      // Sort fees in ascending order for percentile calculation
      fees.sort((a, b) => a - b);
      
      // Calculate statistics
      const minFee = Math.min(...fees);
      const maxFee = Math.max(...fees);
      const averageFee = Math.floor(
        fees.reduce((sum, fee) => sum + fee, 0) / fees.length
      );

      logger.info(`[PRIORITY FEES] Range: ${minFee} - ${maxFee} microLamports (avg: ${averageFee})`);

      // Calculate index for percentile
      const percentileIndex = Math.ceil(fees.length * this.priorityFeePercentile);
      let percentileFee = fees[percentileIndex - 1];  // -1 because array is 0-based
      
      // Ensure fee is not below minimum
      percentileFee = Math.max(percentileFee, minimumFee);
      
      logger.info(`[PRIORITY FEES] Used: ${percentileFee} microLamports`);

      // Cache the result
      Solana.lastPriorityFeeEstimate = {
        timestamp: Date.now(),
        fee: percentileFee,
      };

      return percentileFee;

    } catch (error: any) {
      throw new Error(`Failed to fetch priority fees: ${error.message}`);
    }
  }

  public async confirmTransaction(
    signature: string,
    connection: Connection,
    timeout: number = 3000,
  ): Promise<{ confirmed: boolean; txData?: any }> {
    try {
      const confirmationPromise = new Promise<{ confirmed: boolean; txData?: any }>(async (resolve, reject) => {
        const payload = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [
            [signature],
            {
              searchTransactionHistory: true,
            },
          ],
        };

        const response = await fetch(connection.rpcEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          reject(new Error(`HTTP error! status: ${response.status}`));
          return;
        }

        const data = await response.json();

        if (data.result && data.result.value && data.result.value[0]) {
          const status = data.result.value[0];
          
          if (status.err !== null) {
            reject(new Error(`Transaction failed with error: ${JSON.stringify(status.err)}`));
            return;
          }
          
          const isConfirmed =
            status.confirmationStatus === 'confirmed' || 
            status.confirmationStatus === 'finalized';

          if (isConfirmed) {
            // Fetch transaction data if confirmed
            const txData = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
            });
            resolve({ confirmed: true, txData });
          } else {
            resolve({ confirmed: false });
          }
        } else {
          resolve({ confirmed: false });
        }
      });

      const timeoutPromise = new Promise<{ confirmed: boolean }>((_, reject) =>
        setTimeout(() => reject(new Error('Confirmation timed out')), timeout),
      );

      return await Promise.race([confirmationPromise, timeoutPromise]);
    } catch (error: any) {
      throw new Error(`Failed to confirm transaction: ${error.message}`);
    }
  }

  async sendAndConfirmTransaction(
    tx: Transaction, 
    signers: Signer[] = []
  ): Promise<string> {
    let currentPriorityFee = await this.estimatePriorityFees(
      this.connectionPool.getNextConnection().rpcEndpoint,
    );
    
    while (currentPriorityFee <= this.maxPriorityFee) {
      // Update or add priority fee instruction
      const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor(currentPriorityFee),
      });
      
      // Remove any existing priority fee instructions and add the new one
      tx.instructions = [
        ...tx.instructions.filter(inst => !inst.programId.equals(ComputeBudgetProgram.programId)),
        priorityFeeInstruction
      ];

      // Get latest blockhash
      const blockhashAndContext = await this.connectionPool
        .getNextConnection()
        .getLatestBlockhashAndContext('confirmed');
      
      const lastValidBlockHeight = blockhashAndContext.value.lastValidBlockHeight;
      const blockhash = blockhashAndContext.value.blockhash;

      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.recentBlockhash = blockhash;
      tx.sign(...signers);

      let retryCount = 0;
      while (retryCount < this.retryCount) {
        try {
          const signature = await this.sendRawTransaction(
            tx.serialize(),
            lastValidBlockHeight,
          );

          // Wait for confirmation
          for (const connection of this.connectionPool.getAllConnections()) {
            try {
              const confirmed = await this.confirmTransaction(signature, connection);
              if (confirmed) {
                logger.info(`Transaction confirmed with priority fee: ${currentPriorityFee} microLamports`);
                return signature;
              }
            } catch (error) {
              logger.warn(`Confirmation attempt failed on connection: ${error.message}`);
            }
          }

          retryCount++;
          await new Promise(resolve => setTimeout(resolve, this.retryIntervalMs));
        } catch (error) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, this.retryIntervalMs));
        }
      }

      // If we get here, transaction wasn't confirmed after RETRY_COUNT attempts
      // Increase the priority fee and try again
      currentPriorityFee = Math.floor(currentPriorityFee * this.priorityFeeMultiplier);
      logger.info(`Increasing priority fee to ${currentPriorityFee} microLamports`);
    }

    throw new Error(`Transaction failed after reaching maximum priority fee of ${this.maxPriorityFee} microLamports`);
  }

  async sendRawTransaction(
    rawTx: Buffer | Uint8Array | Array<number>,
    lastValidBlockHeight: number,
  ): Promise<string> {
    let blockheight = await this.connectionPool
      .getNextConnection()
      .getBlockHeight({ commitment: 'confirmed' });

    let signature: string;
    let signatures: string[];
    let retryCount = 0;

    while (blockheight <= lastValidBlockHeight + 50) {
      const sendRawTransactionResults = await Promise.allSettled(
        this.connectionPool.getAllConnections().map(async (conn) => {
          return await conn.sendRawTransaction(rawTx, {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
            maxRetries: 0,
          });
        }),
      );

      const successfulResults = sendRawTransactionResults.filter(
        (result) => result.status === 'fulfilled',
      );

      if (successfulResults.length > 0) {
        // Map all successful results to get their values (signatures)
        signatures = successfulResults
          .map((result) => (result.status === 'fulfilled' ? result.value : ''))
          .filter(sig => sig !== ''); // Filter out empty strings

        // Verify all signatures match
        if (!signatures.every((sig) => sig === signatures[0])) {
          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, this.retryIntervalMs));
          continue;
        }

        signature = signatures[0];
        return signature;
      }

      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, this.retryIntervalMs));
    }

    // If we exit the while loop without returning, we've exceeded block height
    throw new Error('Maximum blockheight exceeded');
  }

  async extractTokenBalanceChangeAndFee(
    signature: string,
    mint: string,
    owner: string,
  ): Promise<{ balanceChange: number; fee: number }> {
    let txDetails;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        txDetails = await this.connectionPool.getNextConnection().getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails) {
          break; // Exit loop if txDetails is not null
        } else {
          throw new Error('Transaction details are null');
        }
      } catch (error: any) {
        if (attempt < 10) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          // Return default values after 10 attempts
          return { balanceChange: 0, fee: 0 };
        }
      }
    }

    const preTokenBalances = txDetails.meta?.preTokenBalances || [];
    const postTokenBalances = txDetails.meta?.postTokenBalances || [];

    const preBalance =
      preTokenBalances.find((balance) => balance.mint === mint && balance.owner === owner)
        ?.uiTokenAmount.uiAmount || 0;

    const postBalance =
      postTokenBalances.find((balance) => balance.mint === mint && balance.owner === owner)
        ?.uiTokenAmount.uiAmount || 0;

    const balanceChange = postBalance - preBalance;
    const fee = (txDetails.meta?.fee || 0) / 1_000_000_000; // Convert lamports to SOL

    return { balanceChange, fee };
  }

  async extractAccountBalanceChangeAndFee(
    signature: string,
    accountIndex: number,
  ): Promise<{ balanceChange: number; fee: number }> {
    let txDetails;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        txDetails = await this.connectionPool.getNextConnection().getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails) {
          break; // Exit loop if txDetails is not null
        } else {
          throw new Error('Transaction details are null');
        }
      } catch (error: any) {
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          // Return default values after 10 attempts
          return { balanceChange: 0, fee: 0 };
        }
      }
    }

    const preBalances = txDetails.meta?.preBalances || [];
    const postBalances = txDetails.meta?.postBalances || [];

    const balanceChange =
      Math.abs(postBalances[accountIndex] - preBalances[accountIndex]) / 1_000_000_000;
    const fee = (txDetails.meta?.fee || 0) / 1_000_000_000; // Convert lamports to SOL

    return { balanceChange, fee };
  }

}

export type Solanaish = Solana;
export const Solanaish = Solana;

