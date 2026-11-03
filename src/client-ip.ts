import { isIP, isIPv6 } from "node:net";
import type { Request } from "@hapi/hapi";
import type { ClientIpSource } from "./types";

const MAX_ADDRESS_LENGTH = 64;

/** CloudFront sets this from the viewer's connection, so a browser can't choose it. */
export const DEFAULT_IP_SOURCES: ClientIpSource[] = [
  { header: "cloudfront-viewer-address", hasPort: true },
];

const headerValue = (request: Request, name: string): string | undefined => {
  const value = request.headers[name.toLowerCase()];

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Returns the bare address, or undefined if `raw` isn't a single valid one. */
export function parseAddress(raw: string | undefined, hasPort = false): string | undefined {
  if (!raw || raw.length > MAX_ADDRESS_LENGTH) {
    return undefined;
  }

  const trimmed = raw.trim();
  const address = stripIpv4Mapping(stripPort(trimmed, hasPort));

  return isIP(address) ? address : undefined;
}

function stripPort(value: string, hasPort: boolean): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(value);

  if (bracketed?.[1]) {
    return bracketed[1];
  }

  if (hasPort) {
    const separator = value.lastIndexOf(":");

    return separator > 0 ? value.slice(0, separator) : value;
  }

  return value.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
}

function stripIpv4Mapping(value: string): string {
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);

  if (hex?.[1] && hex[2]) {
    const [high, low] = [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16)];

    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }

  return value.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

/** Walks the configured sources in order, then falls back to the socket address. */
export async function resolveClientIp(
  request: Request,
  sources: ClientIpSource[],
): Promise<string | undefined> {
  for (const source of sources) {
    if (source.when && !(await source.when(request))) {
      continue;
    }

    const address = readSource(request, source);

    if (address) {
      return address;
    }
  }

  return parseAddress(request.info.remoteAddress);
}

function readSource(request: Request, source: ClientIpSource): string | undefined {
  if ("header" in source) {
    return parseAddress(headerValue(request, source.header), source.hasPort);
  }

  // Proxies append, so only the last `hops` entries were written by infrastructure you control.
  const entries = headerValue(request, "x-forwarded-for")?.split(",");

  return parseAddress(entries?.at(-source.forwardedForHops));
}

/**
 * Counts IPv6 clients per /64 network. A single customer usually controls a whole
 * /64, so counting per address would let them pick a new identity for each request.
 */
export function toRateLimitIdentity(ip: string): string {
  if (!isIPv6(ip)) {
    return ip;
  }

  return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip: string): string[] {
  const [address = ""] = ip.split("%", 1);
  const [head = "", tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0");

  return [...headGroups, ...missing, ...tailGroups].map((group) =>
    group.toLowerCase().padStart(4, "0"),
  );
}
