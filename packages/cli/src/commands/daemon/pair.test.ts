import { describe, expect, test, vi } from "vitest";

import { runPairCommand, type PairCommandOutput, type PairingOffer } from "./pair.js";

const disabledOffer: PairingOffer = { relayEnabled: false, url: null, qr: null };
const enabledOffer: PairingOffer = {
  relayEnabled: true,
  url: "https://app.paseo.sh/#offer=test",
  qr: null,
};

interface RecordedPairCommandOutput extends PairCommandOutput {
  stdout: string[];
  stderr: string[];
  successes: string[];
  exitCode: number | undefined;
}

function createRecordedOutput(): RecordedPairCommandOutput {
  return {
    columns: 80,
    stdout: [],
    stderr: [],
    successes: [],
    exitCode: undefined,
    writeStdout(message) {
      this.stdout.push(message);
    },
    writeStderr(message) {
      this.stderr.push(message);
    },
    setExitCode(code) {
      this.exitCode = code;
    },
    success(message) {
      this.successes.push(message);
    },
  };
}

describe("daemon pair workflow", () => {
  test("interactive use prints direct guidance and creates no pairing output", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const printDirectGuidance = vi.fn();
    const output = createRecordedOutput();

    await runPairCommand(
      {},
      { resolveOffer, printDirectGuidance, isInteractive: () => true, output },
    );

    expect(printDirectGuidance).toHaveBeenCalledOnce();
    expect(output.stderr.join("")).toContain("direct Tailscale");
    expect(output.exitCode).toBe(1);
  });

  test("interactive use does not implicitly enable relay", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const output = createRecordedOutput();

    await runPairCommand(
      {},
      {
        resolveOffer,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
        output,
      },
    );

    expect(resolveOffer).toHaveBeenCalledOnce();
    expect(resolveOffer).toHaveBeenCalledWith(expect.objectContaining({ enableRelay: false }));
    expect(output.stdout).toEqual([]);
  });

  test("JSON mode never prompts and returns a structured relay-disabled error", async () => {
    const output = createRecordedOutput();

    await runPairCommand(
      { json: true },
      {
        resolveOffer: async () => disabledOffer,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
        output,
      },
    );

    expect(output.stderr.join("")).toContain('"code":"RELAY_DISABLED"');
    expect(output.stderr.join("")).toContain("direct host over Tailscale");
    expect(output.exitCode).toBe(1);
  });

  test("explicit relay opts in without prompting", async () => {
    const resolveOffer = vi.fn(async () => enabledOffer);
    const output = createRecordedOutput();

    await runPairCommand(
      { relay: true, json: true },
      {
        resolveOffer,
        printDirectGuidance: vi.fn(),
        isInteractive: () => false,
        output,
      },
    );

    expect(resolveOffer).toHaveBeenCalledWith(expect.objectContaining({ enableRelay: true }));
    expect(output.exitCode).toBeUndefined();
  });

  test("surfaces launch-override rejection", async () => {
    await expect(
      runPairCommand(
        { relay: true },
        {
          resolveOffer: async () => {
            throw new Error("Relay is controlled by a daemon launch override");
          },
          printDirectGuidance: vi.fn(),
          isInteractive: () => false,
          output: createRecordedOutput(),
        },
      ),
    ).rejects.toThrow("launch override");
  });
});
