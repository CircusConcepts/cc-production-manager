export function formatDuplicateSerialError(
  sku: string,
  serialNumber: string,
): string {
  return `SKU ${sku} already has serial number ${serialNumber}.`;
}

export function formatItemIdentity(sku: string, serialNumber: string): string {
  return `${sku}-${serialNumber}`;
}
