import { getBytes, keccak256 } from 'ethers';

const BLOOM_BYTES = 256;

/** True when all three bloom bits of the value (address or topic) are set in the 2048-bit logsBloom. */
export function bloomMayContain(logsBloom: string, hexValue: string): boolean {
  const bloom = getBytes(logsBloom);
  if (bloom.length !== BLOOM_BYTES) return false;
  const hash = getBytes(keccak256(getBytes(hexValue)));
  for (const i of [0, 2, 4]) {
    const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
    if ((bloom[BLOOM_BYTES - 1 - (bit >> 3)] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/** True when the bloom may contain any of the addresses AND any of the topics. */
export function blockMayMatch(logsBloom: string, addresses: string[], topics: string[]): boolean {
  if (addresses.length === 0 || topics.length === 0) return false;
  return addresses.some((a) => bloomMayContain(logsBloom, a)) && topics.some((t) => bloomMayContain(logsBloom, t));
}
