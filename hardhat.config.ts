import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-verify";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

import { configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatNetworkHelpers],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    avalanche: {
      type: "http",
      chainType: "l1",
      chainId: 43114,
      url: configVariable("AVALANCHE_RPC_URL"),
      accounts: [configVariable("AVALANCHE_PRIVATE_KEY")],
    },
  },

  // configuration for etherscan-verify from hardhat-deploy plugin
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
    
  },
  chainDescriptors: {
    43114: {
      name: 'Avalanche',
      blockExplorers: {
        etherscan: {
          name: "Routescan",
          url: "https://43114.routescan.io/",
          apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
        },
      },
    },
    11155111: {
      name: 'Sepolia',
      blockExplorers: {
        etherscan: {
          name: "Routescan",
          url: "https://11155111.routescan.io/",
          apiUrl: "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan",
        },
      },
    },
  },

};

export default config;
