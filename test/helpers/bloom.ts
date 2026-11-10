import { getBytes, keccak256 } from 'ethers';

/** Builds an Ethereum logsBloom (2048 bits) containing the given addresses / topics. */
export function makeBloom(values: string[]): string {
  const bloom = new Uint8Array(256);
  for (const v of values) {
    const h = getBytes(keccak256(v));
    for (const i of [0, 2, 4]) {
      const bit = ((h[i] << 8) | h[i + 1]) & 2047;
      bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
    }
  }
  return '0x' + Buffer.from(bloom).toString('hex');
}
