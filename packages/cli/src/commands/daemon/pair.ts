import { log } from "@clack/prompts";
import { Command } from "commander";
import chalk from "chalk";
import {
  generateLocalPairingOffer,
  getOrCreateServerId,
  loadConfig,
  resolvePaseoHome,
} from "@getpaseo/server";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState } from "./local-daemon.js";
import { addJsonOption } from "../../utils/command-options.js";
import { formatPairingInstructions } from "../../output/pairing.js";

interface PairOptions {
  home?: string;
  json?: boolean;
  relay?: boolean;
}

export interface PairCommandDependencies {
  resolveOffer: typeof resolveLocalPairingOffer;
  printDirectGuidance: typeof printDirectConnectionGuidance;
  isInteractive: () => boolean;
  output: PairCommandOutput;
}

export interface PairCommandOutput {
  columns: number | undefined;
  writeStdout(message: string): void;
  writeStderr(message: string): void;
  setExitCode(code: number): void;
  success(message: string): void;
}

export interface PairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
}

const PAIRING_DAEMON_RPC_TIMEOUT_MS = 1500;
const CONNECTIVITY_DOCS_URL =
  "https://github.com/Dey11/paseo/blob/hanabicode/docs/fork-docs/connectivity-and-services.md";

function createProcessOutput(): PairCommandOutput {
  return {
    columns: process.stdout.columns,
    writeStdout(message) {
      process.stdout.write(message);
    },
    writeStderr(message) {
      process.stderr.write(message);
    },
    setExitCode(code) {
      process.exitCode = code;
    },
    success(message) {
      log.success(message);
    },
  };
}

export function pairCommand(): Command {
  return addJsonOption(new Command("pair").description("Print the daemon pairing QR code and link"))
    .option("--home <path>", "HanabiCode home directory (default: ~/.hanabicode)")
    .option("--relay", "Enable relay without prompting")
    .action(async (_options: PairOptions, command: Command) => {
      await runPairCommand(command.optsWithGlobals());
    });
}

export async function resolveLocalPairingOffer(options: {
  paseoHome: string;
  enableRelay?: boolean;
}): Promise<PairingOffer> {
  const state = resolveLocalDaemonState({ home: options.paseoHome });
  const serverId = getOrCreateServerId(state.home);
  const daemonOffer = await resolveDaemonPairingOffer(state.listen, serverId, options.enableRelay);
  if (daemonOffer) return daemonOffer;

  if (state.running) {
    throw new Error(
      "The running daemon did not provide a pairing offer. Check daemon connectivity or update the daemon.",
    );
  }

  const config = loadConfig(options.paseoHome);
  if (options.enableRelay && !config.relayEnabled) {
    throw new Error("Start the daemon before enabling relay for pairing.");
  }

  return generateLocalPairingOffer({
    paseoHome: options.paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    relayUseTls: config.relayUseTls,
    relayPublicUseTls: config.relayPublicUseTls,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  });
}

async function resolveDaemonPairingOffer(
  listen: string,
  expectedServerId: string,
  enableRelay: boolean | undefined,
): Promise<PairingOffer | null> {
  const client = await tryConnectToDaemon({
    host: listen,
    timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
  });
  if (!client) return null;

  try {
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.serverId.trim() !== expectedServerId) {
      throw new Error(
        "The reachable daemon belongs to a different HanabiCode home. Check --home or the daemon listen configuration.",
      );
    }
    if (serverInfo?.features?.daemonStatusRpc !== true) {
      throw new Error("Update the HanabiCode daemon before pairing from this command.");
    }

    let offer = await client.getDaemonPairingOffer({
      timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
    });
    if (!offer.relayEnabled && enableRelay) {
      if (serverInfo.features.relayConfig !== true) {
        throw new Error("Update the HanabiCode daemon before enabling relay from this command.");
      }
      await client.patchDaemonConfig({ relay: { enabled: true } });
      offer = await client.getDaemonPairingOffer({
        timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
      });
    }
    return {
      relayEnabled: offer.relayEnabled,
      url: offer.url || null,
      qr: offer.qr ?? null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function printDirectConnectionGuidance(): void {
  console.log("Daemon is running with relay off.");
  console.log(
    "Add the daemon's TCP address as a direct host over Tailscale or another private network.",
  );
  console.log(`Learn more: ${CONNECTIVITY_DOCS_URL}`);
}

export async function runPairCommand(
  options: PairOptions,
  dependencyOverrides: Partial<PairCommandDependencies> = {},
): Promise<void> {
  if (options.home) process.env.PASEO_HOME = options.home;
  const dependencies: PairCommandDependencies = {
    resolveOffer: resolveLocalPairingOffer,
    printDirectGuidance: printDirectConnectionGuidance,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    output: createProcessOutput(),
    ...dependencyOverrides,
  };

  const paseoHome = resolvePaseoHome();
  const pairing = await dependencies.resolveOffer({
    paseoHome,
    enableRelay: options.relay === true,
  });

  if (!pairing.relayEnabled && options.json !== true) {
    dependencies.printDirectGuidance();
  }

  outputPairingResult(pairing, options, dependencies.output);
}

function outputPairingResult(
  pairing: PairingOffer,
  options: PairOptions,
  output: PairCommandOutput,
): void {
  if (!pairing.relayEnabled || !pairing.url) {
    if (options.json) {
      output.writeStderr(
        `${JSON.stringify({
          code: "RELAY_DISABLED",
          message: "Relay pairing is disabled for this daemon.",
          action: "Add a direct host over Tailscale or the configured private network.",
        })}\n`,
      );
    } else {
      output.writeStderr(`${chalk.red("Relay pairing is disabled for this daemon.")}\n`);
      output.writeStderr(`${chalk.yellow("Use a direct Tailscale or private-network host.")}\n`);
    }
    output.setExitCode(1);
    return;
  }

  if (options.json) {
    output.writeStdout(
      `${JSON.stringify(
        { relayEnabled: pairing.relayEnabled, url: pairing.url, qr: pairing.qr },
        null,
        2,
      )}\n`,
    );
    return;
  }

  output.writeStdout(
    formatPairingInstructions({
      url: pairing.url,
      qr: pairing.qr,
      columns: output.columns,
    }),
  );
}
