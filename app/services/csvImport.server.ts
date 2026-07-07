import type { ItemStatus, Prisma } from "@prisma/client";
import { isValid, parse, parseISO } from "date-fns";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";

import db from "../db.server";
import { ensureColorByName } from "./color.server";
import { resolveDefaultStatus } from "../utils/itemStatus";
import { normalizeSku } from "../utils/sku";
import {
  formatDuplicateSerialError,
  formatItemIdentity,
} from "../utils/serializedItem";
import { ensureProductForSku } from "./productSku.server";
import { createAuditLog } from "./audit.server";

export type ImportMode = "skip" | "update" | "fail";

export interface ImportRowError {
  rowNumber: number;
  sku?: string;
  serialNumber?: string;
  message: string;
}

export interface ImportRowSkipped {
  rowNumber: number;
  sku?: string;
  serialNumber?: string;
  reason: string;
}

export interface ImportSummary {
  totalRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  errors: ImportRowError[];
  skipped: ImportRowSkipped[];
  importBatchId: string;
}

interface NormalizedCsvRow {
  rowNumber: number;
  sku: string;
  productName?: string;
  category?: string;
  serialNumber: string;
  orderNumber?: string;
  productionDate?: string;
  madeBy?: string;
  color?: string;
  size?: string;
  status?: string;
  notes?: string;
}

interface ValidatedRow extends NormalizedCsvRow {
  resolvedStatus: ItemStatus;
  completedAt: Date | null;
}

const importModeSchema = z.enum(["skip", "update", "fail"]);

const SKU_HEADERS = [
  "sku",
  "product sku",
  "item sku",
  "code",
  "product code",
];

const NAME_HEADERS = [
  "name",
  "product name",
  "item name",
  "description",
  "product description",
];

const SERIAL_HEADERS = [
  "serial number",
  "serial",
  "serial no",
  "serial no.",
  "serial #",
  "serial number unique",
];

const ORDER_HEADERS = [
  "order number",
  "order",
  "order no",
  "order no.",
  "order #",
  "shopify order",
  "customer order",
];

const DATE_HEADERS = [
  "production date",
  "made date",
  "completed date",
  "date",
  "created date",
];

const EMPLOYEE_HEADERS = [
  "employee",
  "made by",
  "maker",
  "produced by",
  "operator",
  "worker",
  "staff",
];

const STATUS_HEADERS = ["status", "item status", "production status"];

const NOTES_HEADERS = ["notes", "note", "comment", "comments", "remarks"];

const COLOR_HEADERS = ["color", "colour", "item color", "item colour"];

const CATEGORY_HEADERS = [
  "category",
  "product category",
  "item category",
  "type",
  "product type",
];

const SIZE_HEADERS = ["size", "item size", "product size"];

const STATUS_MAP: Record<string, ItemStatus> = {
  planned: "PLANNED",
  "in production": "IN_PRODUCTION",
  production: "IN_PRODUCTION",
  cutting: "CUTTING",
  sewing: "SEWING",
  assembly: "ASSEMBLY",
  assembling: "ASSEMBLY",
  qc: "QC",
  "quality control": "QC",
  ready: "READY",
  completed: "READY",
  complete: "READY",
  done: "READY",
  "in stock": "IN_STOCK",
  stock: "IN_STOCK",
  stocked: "IN_STOCK",
  reserved: "RESERVED",
  shipped: "SHIPPED",
  delivered: "SHIPPED",
  scrap: "SCRAPPED",
  scrapped: "SCRAPPED",
};

const DATE_FORMATS = ["yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy", "yyyy/MM/dd"];

const CHUNK_SIZE = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

function buildNormalizedRecord(
  raw: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    result[normalizeHeader(key)] = trimmed;
  }

  return result;
}

export function getValueByPossibleHeaders(
  record: Record<string, string>,
  possibleHeaders: string[],
): string | undefined {
  for (const header of possibleHeaders) {
    const value = record[normalizeHeader(header)];
    if (value) return value;
  }
  return undefined;
}

export function normalizeStatus(
  value: string | undefined,
): { status?: ItemStatus; error?: string } {
  if (!value) return {};

  const key = value.toLowerCase().trim().replace(/\s+/g, " ");
  const mapped = STATUS_MAP[key];

  if (!mapped) {
    return { error: `Unknown status "${value}".` };
  }

  return { status: mapped };
}

export function parseProductionDate(
  value: string | undefined,
): { date: Date | null; error?: string } {
  if (!value) return { date: null };

  const trimmed = value.trim();
  if (!trimmed) return { date: null };

  const isoParsed = parseISO(trimmed);
  if (isValid(isoParsed)) return { date: isoParsed };

  const native = new Date(trimmed);
  if (!Number.isNaN(native.getTime()) && trimmed.includes("-")) {
    return { date: native };
  }

  for (const format of DATE_FORMATS) {
    const parsed = parse(trimmed, format, new Date());
    if (isValid(parsed)) return { date: parsed };
  }

  return { date: null, error: `Could not parse date "${value}".` };
}

function normalizeRawRow(
  raw: Record<string, string | undefined>,
  rowNumber: number,
): NormalizedCsvRow | null {
  const record = buildNormalizedRecord(raw);

  if (Object.keys(record).length === 0) return null;

  const sku = getValueByPossibleHeaders(record, SKU_HEADERS);
  const serialNumber = getValueByPossibleHeaders(record, SERIAL_HEADERS);

  return {
    rowNumber,
    sku: normalizeSku(sku ?? ""),
    productName: getValueByPossibleHeaders(record, NAME_HEADERS),
    category: getValueByPossibleHeaders(record, CATEGORY_HEADERS),
    serialNumber: serialNumber ?? "",
    orderNumber: getValueByPossibleHeaders(record, ORDER_HEADERS),
    productionDate: getValueByPossibleHeaders(record, DATE_HEADERS),
    madeBy: getValueByPossibleHeaders(record, EMPLOYEE_HEADERS),
    color: getValueByPossibleHeaders(record, COLOR_HEADERS),
    size: getValueByPossibleHeaders(record, SIZE_HEADERS),
    status: getValueByPossibleHeaders(record, STATUS_HEADERS),
    notes: getValueByPossibleHeaders(record, NOTES_HEADERS),
  };
}

export function detectDuplicateSkuSerialWithinFile(
  rows: NormalizedCsvRow[],
): ImportRowError[] {
  const seen = new Map<
    string,
    { rowNumber: number; sku: string; serialNumber: string }
  >();
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (!row.sku || !row.serialNumber) continue;

    const key = `${normalizeSku(row.sku)}::${row.serialNumber.trim()}`;
    const first = seen.get(key);

    if (first !== undefined) {
      errors.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        serialNumber: row.serialNumber,
        message: `SKU ${row.sku} already has serial number ${row.serialNumber} in this CSV (first seen on row ${first.rowNumber}).`,
      });
    } else {
      seen.set(key, {
        rowNumber: row.rowNumber,
        sku: row.sku,
        serialNumber: row.serialNumber,
      });
    }
  }

  return errors;
}

export function validateRows(rows: NormalizedCsvRow[]): {
  validRows: ValidatedRow[];
  errors: ImportRowError[];
} {
  const errors: ImportRowError[] = [];
  const validRows: ValidatedRow[] = [];

  for (const row of rows) {
    if (!row.sku) {
      errors.push({
        rowNumber: row.rowNumber,
        serialNumber: row.serialNumber || undefined,
        message: "SKU is required.",
      });
      continue;
    }

    if (!row.serialNumber) {
      errors.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        message: "Serial number is required.",
      });
      continue;
    }

    const statusResult = normalizeStatus(row.status);
    if (statusResult.error) {
      errors.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        serialNumber: row.serialNumber,
        message: statusResult.error,
      });
      continue;
    }

    const dateResult = parseProductionDate(row.productionDate);
    if (dateResult.error) {
      errors.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        serialNumber: row.serialNumber,
        message: dateResult.error,
      });
      continue;
    }

    validRows.push({
      ...row,
      resolvedStatus: resolveDefaultStatus(row.orderNumber, statusResult.status),
      completedAt: dateResult.date,
    });
  }

  return { validRows, errors };
}

async function resolveColorForImport(
  shopId: string,
  colorName?: string,
): Promise<{ colorId: string | null; colorLabel: string | null }> {
  if (!colorName?.trim()) {
    return { colorId: null, colorLabel: null };
  }

  const color = await ensureColorByName(shopId, colorName);
  if (!color) {
    return { colorId: null, colorLabel: null };
  }

  return { colorId: color.id, colorLabel: color.name };
}

async function processChunk({
  shopId,
  rows,
  importMode,
  existingSerials,
}: {
  shopId: string;
  rows: ValidatedRow[];
  importMode: ImportMode;
  existingSerials: Map<string, { id: string; productId: string }>;
}): Promise<{
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  errors: ImportRowError[];
  skipped: ImportRowSkipped[];
  auditEntries: Prisma.AuditLogCreateManyInput[];
}> {
  let importedRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  let failedRows = 0;
  const errors: ImportRowError[] = [];
  const skipped: ImportRowSkipped[] = [];
  const auditEntries: Prisma.AuditLogCreateManyInput[] = [];

  for (const row of rows) {
    try {
      const product = await ensureProductForSku(
        shopId,
        row.sku,
        row.productName,
        row.category,
      );
      const { colorId, colorLabel } = await resolveColorForImport(
        shopId,
        row.color,
      );
      const compositeKey = `${product.id}::${row.serialNumber.trim()}`;
      const existing = existingSerials.get(compositeKey);

      if (!existing) {
        const item = await db.serializedItem.create({
          data: {
            shopId,
            productId: product.id,
            serialNumber: row.serialNumber.trim(),
            sourceType: "IMPORT",
            status: row.resolvedStatus,
            orderNumber: row.orderNumber ?? null,
            madeBy: row.madeBy ?? null,
            colorId,
            color: colorLabel ?? row.color ?? null,
            size: row.size ?? null,
            completedAt: row.completedAt,
            notes: row.notes ?? null,
          },
        });

        existingSerials.set(compositeKey, {
          id: item.id,
          productId: product.id,
        });

        importedRows += 1;
        auditEntries.push({
          shopId,
          action: "SERIALIZED_ITEM_CREATED_FROM_IMPORT",
          entity: "SerializedItem",
          entityId: item.id,
          metadata: {
            rowNumber: row.rowNumber,
            productId: product.id,
            sku: row.sku,
            productName: row.productName ?? row.sku,
            serialNumber: row.serialNumber,
            itemIdentity: formatItemIdentity(row.sku, row.serialNumber),
            category: row.category,
            color: colorLabel ?? row.color,
            size: row.size,
            employee: row.madeBy,
          },
        });
        continue;
      }

      if (importMode === "skip") {
        skippedRows += 1;
        skipped.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          serialNumber: row.serialNumber,
          reason: formatDuplicateSerialError(row.sku, row.serialNumber),
        });
        auditEntries.push({
          shopId,
          action: "SERIALIZED_ITEM_SKIPPED_DUPLICATE_IMPORT",
          entity: "SerializedItem",
          entityId: existing.id,
          metadata: {
            rowNumber: row.rowNumber,
            productId: product.id,
            sku: row.sku,
            productName: row.productName ?? row.sku,
            serialNumber: row.serialNumber,
            itemIdentity: formatItemIdentity(row.sku, row.serialNumber),
          },
        });
        continue;
      }

      if (importMode === "fail") {
        failedRows += 1;
        errors.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          serialNumber: row.serialNumber,
          message: formatDuplicateSerialError(row.sku, row.serialNumber),
        });
        continue;
      }

      await db.serializedItem.update({
        where: { id: existing.id },
        data: {
          productId: product.id,
          orderNumber: row.orderNumber ?? null,
          madeBy: row.madeBy ?? null,
          colorId,
          color: colorLabel ?? row.color ?? null,
          size: row.size ?? null,
          completedAt: row.completedAt,
          notes: row.notes ?? null,
          status: row.resolvedStatus,
        },
      });

      updatedRows += 1;
      auditEntries.push({
        shopId,
        action: "SERIALIZED_ITEM_UPDATED_FROM_IMPORT",
        entity: "SerializedItem",
        entityId: existing.id,
        metadata: {
          rowNumber: row.rowNumber,
          productId: product.id,
          sku: row.sku,
          productName: row.productName ?? row.sku,
          serialNumber: row.serialNumber,
          itemIdentity: formatItemIdentity(row.sku, row.serialNumber),
          category: row.category,
          color: colorLabel ?? row.color,
          size: row.size,
          employee: row.madeBy,
        },
      });
    } catch {
      failedRows += 1;
      errors.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        serialNumber: row.serialNumber,
        message: "Could not save this row. Please check the data and try again.",
      });
    }
  }

  return {
    importedRows,
    updatedRows,
    skippedRows,
    failedRows,
    errors,
    skipped,
    auditEntries,
  };
}

export async function importHistoricalCsv({
  shopId,
  filename,
  fileText,
  importMode,
}: {
  shopId: string;
  filename: string;
  fileText: string;
  importMode: ImportMode;
}): Promise<ImportSummary> {
  const parsedMode = importModeSchema.safeParse(importMode);
  if (!parsedMode.success) {
    throw new Error("Invalid import mode.");
  }

  let records: Record<string, string | undefined>[];

  try {
    records = parseCsv(fileText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string | undefined>[];
  } catch {
    throw new Error("Could not read the CSV file. Check the format and try again.");
  }

  const normalizedRows: NormalizedCsvRow[] = [];

  records.forEach((record, index) => {
    const row = normalizeRawRow(record, index + 2);
    if (row) normalizedRows.push(row);
  });

  const duplicateErrors = detectDuplicateSkuSerialWithinFile(normalizedRows);
  const duplicateRowNumbers = new Set(duplicateErrors.map((e) => e.rowNumber));

  const rowsWithoutFileDuplicates = normalizedRows.filter(
    (row) => !duplicateRowNumbers.has(row.rowNumber),
  );

  const { validRows, errors: validationErrors } = validateRows(
    rowsWithoutFileDuplicates,
  );

  const allErrors: ImportRowError[] = [...duplicateErrors, ...validationErrors];

  const serialNumbers = validRows.map((row) => row.serialNumber);
  const existingItems = await db.serializedItem.findMany({
    where: { shopId, serialNumber: { in: serialNumbers } },
    select: { id: true, serialNumber: true, productId: true },
  });

  const existingSerials = new Map(
    existingItems.map((item) => [
      `${item.productId}::${item.serialNumber}`,
      { id: item.id, productId: item.productId },
    ]),
  );

  let importedRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  let failedRows = allErrors.length;
  const skipped: ImportRowSkipped[] = [];
  const auditEntries: Prisma.AuditLogCreateManyInput[] = [];

  for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
    const chunk = validRows.slice(i, i + CHUNK_SIZE);
    const result = await processChunk({
      shopId,
      rows: chunk,
      importMode: parsedMode.data,
      existingSerials,
    });

    importedRows += result.importedRows;
    updatedRows += result.updatedRows;
    skippedRows += result.skippedRows;
    failedRows += result.failedRows;
    allErrors.push(...result.errors);
    skipped.push(...result.skipped);
    auditEntries.push(...result.auditEntries);
  }

  const totalRows = normalizedRows.length;
  const successRows = importedRows + updatedRows;

  const importBatch = await db.importBatch.create({
    data: {
      shopId,
      filename,
      totalRows,
      successRows,
      failedRows,
      errors: {
        importedRows,
        updatedRows,
        skippedRows,
        failedRows,
        errors: allErrors,
        skipped,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  if (auditEntries.length > 0) {
    for (let i = 0; i < auditEntries.length; i += CHUNK_SIZE) {
      await db.auditLog.createMany({
        data: auditEntries.slice(i, i + CHUNK_SIZE),
      });
    }
  }

  await createAuditLog({
    shopId,
    action: "HISTORICAL_CSV_IMPORT_COMPLETED",
    entity: "ImportBatch",
    entityId: importBatch.id,
    metadata: {
      filename,
      importMode: parsedMode.data,
      totalRows,
      importedRows,
      updatedRows,
      skippedRows,
      failedRows,
    },
  });

  return {
    totalRows,
    importedRows,
    updatedRows,
    skippedRows,
    failedRows,
    errors: allErrors,
    skipped,
    importBatchId: importBatch.id,
  };
}

export function validateCsvUpload(file: File | null): string | null {
  if (!file || !(file instanceof File) || file.size === 0) {
    return "Please choose a CSV file.";
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    return "Only .csv files are accepted.";
  }

  const mime = file.type.toLowerCase();
  if (
    mime &&
    mime !== "text/csv" &&
    mime !== "application/csv" &&
    mime !== "application/vnd.ms-excel" &&
    mime !== "text/plain"
  ) {
    return "The uploaded file does not look like a CSV.";
  }

  if (file.size > MAX_FILE_BYTES) {
    return "File is too large. Maximum size is 10 MB.";
  }

  return null;
}
