import type { ItemSourceType, ItemStatus } from "@prisma/client";

const STATUS_LABELS: Record<ItemStatus, string> = {
  PLANNED: "Planned",
  IN_PRODUCTION: "In production",
  CUTTING: "Cutting",
  SEWING: "Sewing",
  ASSEMBLY: "Assembly",
  QC: "Quality check",
  READY: "Ready",
  IN_STOCK: "In stock",
  RESERVED: "Reserved",
  SHIPPED: "Shipped",
  SCRAPPED: "Scrapped",
};

const SOURCE_LABELS: Record<ItemSourceType, string> = {
  STOCK: "Stock",
  SHOPIFY_ORDER: "Shopify order",
  MANUAL: "Manual entry",
  IMPORT: "Excel import",
};

export function formatStatus(status: ItemStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatSourceType(sourceType: ItemSourceType): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}
