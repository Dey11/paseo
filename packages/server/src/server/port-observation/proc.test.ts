import { describe, expect, test } from "vitest";
import {
  collectDescendantPids,
  compressIpv6,
  isLoopbackOrWildcardAddress,
  parseListeningSocketsV4,
  parseListeningSocketsV6,
  parseProcNetAddressV4,
  parseProcNetAddressV6,
  parseProcStat,
  parseSocketFdLink,
  toPpidMap,
} from "./proc.js";

describe("parseProcNetAddressV4", () => {
  test("decodes little-endian IPv4 words", () => {
    expect(parseProcNetAddressV4("0100007F")).toBe("127.0.0.1");
    expect(parseProcNetAddressV4("00000000")).toBe("0.0.0.0");
    expect(parseProcNetAddressV4("C0A8010A")).toBe("10.1.168.192");
  });
});

describe("parseProcNetAddressV6 / compressIpv6", () => {
  test("decodes 32-bit kernel-byte-order words", () => {
    expect(parseProcNetAddressV6("00000000000000000000000001000000")).toBe("::1");
    expect(parseProcNetAddressV6("00000000000000000000000000000000")).toBe("::");
    // Empirically captured from this kernel: a ::ffff:127.0.0.1 bind renders
    // as "0000000000000000FFFF00000100007F".
    expect(parseProcNetAddressV6("0000000000000000FFFF00000100007F")).toBe("::ffff:127.0.0.1");
    expect(parseProcNetAddressV6("5C117AFD0000E0A100000000A781019B")).toBe(
      "fd7a:115c:a1e0::9b01:81a7",
    );
  });

  test("compresses the longest zero run and skips short runs", () => {
    expect(compressIpv6("fe80:0:0:0:1:2:3:4")).toBe("fe80::1:2:3:4");
    expect(compressIpv6("fe80:0:1:2:3:4:5:6")).toBe("fe80:0:1:2:3:4:5:6");
  });
});

describe("parseListeningSocketsV4", () => {
  const tcpFixture = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   123        0 123456 1 0000000000000000 100 0 0 10 0",
    "   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 789012 1 0000000000000000 100 0 0 10 0",
    "   2: 0100007F:2328 0100007F:0000 01 00000000:00000000 00:00000000 00000000   123        0 999999 1 0000000000000000 100 0 0 10 0",
    "   3: 0100000A:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555555 1 0000000000000000 100 0 0 10 0",
  ].join("\n");

  test("parses listening sockets and skips established and non-socket lines", () => {
    const sockets = parseListeningSocketsV4(tcpFixture);
    expect(sockets).toEqual([
      { inode: "123456", address: "127.0.0.1", port: 8080, protocol: "tcp4" },
      { inode: "789012", address: "0.0.0.0", port: 3000, protocol: "tcp4" },
      { inode: "555555", address: "10.0.0.1", port: 80, protocol: "tcp4" },
    ]);
  });

  test("handles an empty file", () => {
    expect(parseListeningSocketsV4("")).toEqual([]);
  });
});

describe("parseListeningSocketsV6", () => {
  const tcp6Fixture = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   123        0 111111 1 0000000000000000 100 0 0 10 0",
    "   1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222222 1 0000000000000000 100 0 0 10 0",
    "   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333333 1 0000000000000000 100 0 0 10 0",
  ].join("\n");

  test("parses ::1, wildcard ::, and a v4-mapped loopback address", () => {
    const sockets = parseListeningSocketsV6(tcp6Fixture);
    expect(sockets).toEqual([
      { inode: "111111", address: "::1", port: 8080, protocol: "tcp6" },
      { inode: "222222", address: "::", port: 3000, protocol: "tcp6" },
      { inode: "333333", address: "::ffff:127.0.0.1", port: 80, protocol: "tcp6" },
    ]);
  });
});

describe("parseProcStat", () => {
  test("parses ppid when comm contains spaces and parentheses", () => {
    const parsed = parseProcStat(
      "1234 (node (server) main) S 999 1234 1234 0 -1 4194560 1234 0 0 0 0 0 0 0 20 0 1 0 1 2 3",
    );
    expect(parsed).toEqual({ pid: 1234, ppid: 999, comm: "node (server) main" });
  });

  test("returns null for malformed content", () => {
    expect(parseProcStat("not a stat")).toBeNull();
    expect(parseProcStat("1234 (foo) Z")).toBeNull();
  });
});

describe("parseSocketFdLink", () => {
  test("extracts inode from socket fd links", () => {
    expect(parseSocketFdLink("socket:[123456]")).toBe("123456");
    expect(parseSocketFdLink("/home/dev/file.txt")).toBeNull();
    expect(parseSocketFdLink("pipe:[42]")).toBeNull();
  });
});

describe("collectDescendantPids", () => {
  const processes = [
    { pid: 100, ppid: 1, comm: "init" },
    { pid: 200, ppid: 100, comm: "sh" },
    { pid: 300, ppid: 200, comm: "node" },
    { pid: 400, ppid: 200, comm: "other-node" },
    { pid: 500, ppid: 300, comm: "grandchild" },
    { pid: 600, ppid: 1, comm: "unrelated" },
  ];

  test("walks the full descendant tree and excludes the root and unrelated pids", () => {
    const descendants = collectDescendantPids(200, toPpidMap(processes));
    expect(new Set(descendants)).toEqual(new Set([300, 400, 500]));
  });

  test("returns an empty set for a leaf pid", () => {
    expect(collectDescendantPids(600, toPpidMap(processes))).toEqual([]);
  });

  test("terminates on a cycle", () => {
    const cyclic = [
      { pid: 1, ppid: 2, comm: "a" },
      { pid: 2, ppid: 1, comm: "b" },
    ];
    expect(collectDescendantPids(1, toPpidMap(cyclic))).toEqual([2]);
  });
});

describe("isLoopbackOrWildcardAddress", () => {
  test("accepts IPv4/IPv6 loopback and wildcard binds", () => {
    expect(isLoopbackOrWildcardAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackOrWildcardAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackOrWildcardAddress("0.0.0.0")).toBe(true);
    expect(isLoopbackOrWildcardAddress("::")).toBe(true);
    expect(isLoopbackOrWildcardAddress("::1")).toBe(true);
    expect(isLoopbackOrWildcardAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects exact non-loopback binds", () => {
    expect(isLoopbackOrWildcardAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackOrWildcardAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackOrWildcardAddress("fe80::1")).toBe(false);
    expect(isLoopbackOrWildcardAddress("::ffff:10.0.0.1")).toBe(false);
  });
});
