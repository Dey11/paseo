import { readFile, readdir, readlink } from "node:fs/promises";

/**
 * Linux /proc access for workspace port discovery. Parsers are pure functions
 * over fixture strings; the fs-backed adapter is the only real-dependency seam.
 */

export interface ListeningSocket {
  inode: string;
  address: string;
  port: number;
  protocol: "tcp4" | "tcp6";
}

export interface ProcProcessStat {
  pid: number;
  ppid: number;
  comm: string;
}

export interface ProcAdapter {
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  readLink(path: string): Promise<string>;
}

export function createNodeProcAdapter(): ProcAdapter {
  return {
    readFile: (path) => readFile(path, "utf8"),
    readDir: (path) => readdir(path),
    readLink: (path) => readlink(path),
  };
}

function hexWordToDecimal(hex: string): number {
  return Number.parseInt(hex, 16);
}

function parseHexPort(hex: string): number {
  return hexWordToDecimal(hex);
}

/**
 * /proc/net/tcp local_address words are little-endian 32-bit IPv4 addresses:
 * "0100007F" -> 127.0.0.1.
 */
export function parseProcNetAddressV4(hex: string): string {
  const bytes = hex.match(/.{2}/g) ?? [];
  return bytes
    .toReversed()
    .map((byte) => hexWordToDecimal(byte))
    .join(".");
}

/**
 * /proc/net/tcp6 local_address words are 32-bit words in kernel byte order
 * (little-endian byte-reversed on x86): "00000000000000000000000001000000"
 * -> "::1", "5C117AFD0000E0A100000000A781019B" -> "fd7a:115c:a1e0::9b01:81a7".
 */
export function parseProcNetAddressV6(hex: string): string {
  const words = hex.toLowerCase().match(/.{8}/g) ?? [];
  const units: string[] = [];
  for (const word of words) {
    const bytes = word.match(/.{2}/g) ?? [];
    const reversed = bytes.toReversed().join("");
    units.push(...(reversed.match(/.{4}/g) ?? []));
  }
  if (
    units.length === 8 &&
    units.slice(0, 5).every((unit) => unit === "0000") &&
    units[5] === "ffff"
  ) {
    const quad = [units[6].slice(0, 2), units[6].slice(2), units[7].slice(0, 2), units[7].slice(2)]
      .map((byte) => hexWordToDecimal(byte))
      .join(".");
    return `::ffff:${quad}`;
  }
  return compressIpv6(units.join(":"));
}

export function compressIpv6(raw: string): string {
  const parts = raw.split(":").map((part) => part.replace(/^0+/, "") || "0");
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "0") {
      if (runStart === -1) runStart = index;
      runLength += 1;
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  if (bestLength < 2) return parts.join(":");
  const head = parts.slice(0, bestStart).join(":");
  const tail = parts.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

export interface ParsedProcNetEntry {
  localAddressHex: string;
  localPort: number;
  state: string;
  inode: string;
}

function parseProcNetEntries(content: string): ParsedProcNetEntry[] {
  const entries: ParsedProcNetEntry[] = [];
  for (const line of content.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    const local = fields[1] ?? "";
    const [localAddressHex = "", localPortHex = ""] = local.split(":");
    entries.push({
      localAddressHex,
      localPort: parseHexPort(localPortHex),
      state: fields[3] ?? "",
      inode: fields[9] ?? "",
    });
  }
  return entries;
}

/**
 * Parse /proc/net/tcp into listening IPv4 sockets. Only LISTEN (0A) entries
 * can accept tunnel connections; CLOSE_WAIT/ESTABLISHED entries are filtered.
 */
export function parseListeningSocketsV4(content: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const entry of parseProcNetEntries(content)) {
    if (entry.state !== "0A" || !entry.inode) continue;
    sockets.push({
      inode: entry.inode,
      address: parseProcNetAddressV4(entry.localAddressHex),
      port: entry.localPort,
      protocol: "tcp4",
    });
  }
  return sockets;
}

/** Parse /proc/net/tcp6 into listening IPv6 sockets. */
export function parseListeningSocketsV6(content: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const entry of parseProcNetEntries(content)) {
    if (entry.state !== "0A" || !entry.inode) continue;
    sockets.push({
      inode: entry.inode,
      address: parseProcNetAddressV6(entry.localAddressHex),
      port: entry.localPort,
      protocol: "tcp6",
    });
  }
  return sockets;
}

/**
 * Parse /proc/<pid>/stat. The comm field may contain spaces and parentheses,
 * so the parse starts after the last ")".
 */
export function parseProcStat(content: string): ProcProcessStat | null {
  const pidMatch = /^(\d+)/.exec(content);
  const pid = pidMatch ? Number(pidMatch[1]) : NaN;
  const commEnd = content.lastIndexOf(")");
  if (commEnd === -1 || Number.isNaN(pid)) return null;
  const comm = content.slice(content.indexOf("(") + 1, commEnd);
  const rest = content
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1] ?? NaN);
  if (Number.isNaN(ppid)) return null;
  return { pid, ppid, comm };
}

/** Extract the inode from a socket fd symlink target ("socket:[12345]"). */
export function parseSocketFdLink(link: string): string | null {
  const match = /^socket:\[(\d+)\]$/.exec(link);
  return match ? match[1] : null;
}

/** Build a pid -> ppid map from parsed /proc stat contents. */
export function toPpidMap(processes: readonly ProcProcessStat[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const process of processes) {
    map.set(process.pid, process.ppid);
  }
  return map;
}

/**
 * All descendant pids of rootPid (exclusive) through the ppid map. A cycle
 * (corrupt /proc read) terminates through the visited guard.
 */
export function collectDescendantPids(
  rootPid: number,
  ppidByPid: ReadonlyMap<number, number>,
): number[] {
  const childrenByPid = new Map<number, number[]>();
  for (const [pid, ppid] of ppidByPid) {
    const children = childrenByPid.get(ppid) ?? [];
    children.push(pid);
    childrenByPid.set(ppid, children);
  }
  const descendants: number[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = childrenByPid.get(rootPid) ?? [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    if (visited.has(pid)) continue;
    visited.add(pid);
    descendants.push(pid);
    const children = childrenByPid.get(pid);
    if (children) queue.push(...children);
  }
  return descendants;
}

/**
 * A first-release forward target listens on IPv4/IPv6 loopback or a wildcard
 * address. An exact non-loopback bind is reported unavailable rather than
 * widening the daemon's destination policy.
 */
export function isLoopbackOrWildcardAddress(address: string): boolean {
  if (address === "0.0.0.0" || address === "::" || address === "::1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}
