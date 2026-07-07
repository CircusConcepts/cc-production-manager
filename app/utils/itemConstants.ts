import type { ItemSourceType, ItemStatus } from "@prisma/client";

export const ITEM_STATUSES: ItemStatus[] = [
  "PLANNED",
  "IN_PRODUCTION",
  "CUTTING",
  "SEWING",
  "ASSEMBLY",
  "QC",
  "READY",
  "IN_STOCK",
  "RESERVED",
  "SHIPPED",
  "SCRAPPED",
];

export const SOURCE_TYPES: ItemSourceType[] = ["STOCK", "MANUAL", "IMPORT"];

export function isItemStatus(value: string): value is ItemStatus {
  return ITEM_STATUSES.includes(value as ItemStatus);
}

export function isSourceType(value: string): value is ItemSourceType {
  return SOURCE_TYPES.includes(value as ItemSourceType);
}
