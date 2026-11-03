const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAddress,
  resolveClientIp,
  toRateLimitIdentity,
  DEFAULT_IP_SOURCES,
} = require("../dist/client-ip");

const request = (headers = {}, remoteAddress = "10.0.0.1") => ({
  headers,
  info: { remoteAddress },
});

test("parses CloudFront viewer addresses", () => {
  assert.equal(parseAddress("203.0.113.7:51234", true), "203.0.113.7");
  assert.equal(parseAddress("2001:db8::8a2e:370:7334:443", true), "2001:db8::8a2e:370:7334");
  assert.equal(parseAddress("[2001:db8::1]:443", true), "2001:db8::1");
});

test("parses plain, ported and IPv4-mapped addresses", () => {
  assert.equal(parseAddress("203.0.113.7"), "203.0.113.7");
  assert.equal(parseAddress("203.0.113.7:51234"), "203.0.113.7");
  assert.equal(parseAddress("  203.0.113.7 "), "203.0.113.7");
  assert.equal(parseAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(parseAddress("2001:db8::1"), "2001:db8::1");
});

test("rejects anything that is not one valid address", () => {
  for (const value of [
    "",
    "nope",
    "1.2.3",
    "1.2.3.4, 5.6.7.8",
    "999.1.1.1",
    "../../etc",
    "a".repeat(1000),
    undefined,
  ]) {
    assert.equal(parseAddress(value), undefined, String(value));
  }
});

test("rejects a padded address over the length cap before parsing it", () => {
  assert.equal(parseAddress(`${" ".repeat(100)}1.1.1.1`), undefined);
});

test("trusts the CloudFront header by default", async () => {
  const ip = await resolveClientIp(
    request({ "cloudfront-viewer-address": "203.0.113.7:443" }),
    DEFAULT_IP_SOURCES,
  );

  assert.equal(ip, "203.0.113.7");
});

test("ignores other forwarding headers by default", async () => {
  const ip = await resolveClientIp(
    request({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "9.9.9.9", "x-client-ip": "9.9.9.9" }),
    DEFAULT_IP_SOURCES,
  );

  assert.equal(ip, "10.0.0.1");
});

test("a duplicated or invalid CloudFront header falls back to the socket", async () => {
  for (const value of ["1.1.1.1:1, 2.2.2.2:2", "garbage"]) {
    assert.equal(
      await resolveClientIp(request({ "cloudfront-viewer-address": value }), DEFAULT_IP_SOURCES),
      "10.0.0.1",
    );
  }
});

test("a guarded source is ignored until its check passes", async () => {
  const sources = [
    { header: "x-internal-client-ip", when: (req) => req.headers.token === "valid" },
  ];

  assert.equal(
    await resolveClientIp(request({ "x-internal-client-ip": "7.7.7.7" }), sources),
    "10.0.0.1",
  );
  assert.equal(
    await resolveClientIp(request({ "x-internal-client-ip": "7.7.7.7", token: "valid" }), sources),
    "7.7.7.7",
  );
});

test("reads X-Forwarded-For from the right by hop count", async () => {
  const headers = { "x-forwarded-for": "6.6.6.6, 1.1.1.1, 2.2.2.2" };

  assert.equal(await resolveClientIp(request(headers), [{ forwardedForHops: 1 }]), "2.2.2.2");
  assert.equal(await resolveClientIp(request(headers), [{ forwardedForHops: 2 }]), "1.1.1.1");
  assert.equal(await resolveClientIp(request(headers), [{ forwardedForHops: 9 }]), "10.0.0.1");
});

test("uses the next source when one has no value", async () => {
  const sources = [{ header: "x-a" }, { forwardedForHops: 1 }];

  assert.equal(
    await resolveClientIp(request({ "x-forwarded-for": "1.1.1.1" }), sources),
    "1.1.1.1",
  );
});

test("counts IPv6 clients per /64, however the address is written", () => {
  const expected = "2001:0db8:0001:0002::/64";

  assert.equal(toRateLimitIdentity("2001:db8:1:2:3:4:5:6"), expected);
  assert.equal(toRateLimitIdentity("2001:db8:1:2:ffff::1"), expected);
  assert.equal(toRateLimitIdentity("2001:DB8:1:2::"), expected);
  assert.notEqual(toRateLimitIdentity("2001:db8:1:3::1"), expected);
  assert.equal(toRateLimitIdentity("::1"), "0000:0000:0000:0000::/64");
  assert.equal(toRateLimitIdentity("203.0.113.7"), "203.0.113.7");
});

test("strips IPv4 mappings in hex form too", () => {
  assert.equal(parseAddress("::ffff:7f00:1"), "127.0.0.1");
  assert.equal(parseAddress("::FFFF:cb00:7107"), "203.0.113.7");
});
