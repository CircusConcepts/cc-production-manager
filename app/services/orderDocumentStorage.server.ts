import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCAL_UPLOAD_DIR = "./storage/order-documents";

const ALLOWED_EXTENSIONS: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type ValidatedOrderDocument = {
  file: File;
  mimeType: string;
  extension: string;
};

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMaxOrderDocumentBytes(): number {
  return parsePositiveIntEnv("MAX_ORDER_DOCUMENT_BYTES", 10_485_760);
}

export function getMaxOrderDocuments(): number {
  return parsePositiveIntEnv("MAX_ORDER_DOCUMENTS", 10);
}

export function getMaxOrderUploadTotalBytes(): number {
  return parsePositiveIntEnv("MAX_ORDER_UPLOAD_TOTAL_BYTES", 52_428_800);
}

export function getOrderUploadDir(): string {
  const configured = process.env.ORDER_UPLOAD_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ORDER_UPLOAD_DIR must be configured in production for document uploads.",
    );
  }

  return path.resolve(DEFAULT_LOCAL_UPLOAD_DIR);
}

function detectMimeType(buffer: Buffer): {
  mimeType: string;
  extension: string;
} | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mimeType: "application/pdf", extension: ".pdf" };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: ".png" };
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: ".webp" };
  }

  return null;
}

export async function validateOrderDocumentFile(
  file: File,
): Promise<{ ok: true; document: ValidatedOrderDocument } | { ok: false; error: string }> {
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "One or more uploaded documents are empty." };
  }

  const maxBytes = getMaxOrderDocumentBytes();
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `Each document must be 10 MB or smaller.`,
    };
  }

  const originalName = file.name.trim().toLowerCase();
  const extension = path.extname(originalName);
  if (!ALLOWED_EXTENSIONS[extension]) {
    return {
      ok: false,
      error: "Only JPG, PNG, WebP, and PDF files are accepted.",
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectMimeType(buffer);
  if (!detected) {
    return {
      ok: false,
      error: "Uploaded file type is not supported.",
    };
  }

  if (detected.mimeType !== ALLOWED_EXTENSIONS[extension]) {
    return {
      ok: false,
      error: "Uploaded file content does not match its file extension.",
    };
  }

  return {
    ok: true,
    document: {
      file,
      mimeType: detected.mimeType,
      extension: detected.extension,
    },
  };
}

export async function validateOrderDocumentUploads(
  files: File[],
): Promise<
  | { ok: true; documents: ValidatedOrderDocument[] }
  | { ok: false; error: string }
> {
  if (files.length === 0) {
    return { ok: true, documents: [] };
  }

  const maxDocuments = getMaxOrderDocuments();
  if (files.length > maxDocuments) {
    return {
      ok: false,
      error: `A maximum of ${maxDocuments} documents can be uploaded per request.`,
    };
  }

  const maxTotal = getMaxOrderUploadTotalBytes();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxTotal) {
    return {
      ok: false,
      error: "Combined upload size exceeds the 50 MB limit.",
    };
  }

  const documents: ValidatedOrderDocument[] = [];
  for (const file of files) {
    const result = await validateOrderDocumentFile(file);
    if (!result.ok) {
      return result;
    }
    documents.push(result.document);
  }

  return { ok: true, documents };
}

export function buildOrderDocumentStorageKey({
  shopId,
  productionOrderId,
  extension,
}: {
  shopId: string;
  productionOrderId: string;
  extension: string;
}): string {
  const fileId = randomUUID();
  return `${shopId}/${productionOrderId}/${fileId}${extension}`;
}

export function resolveOrderDocumentPath(storageKey: string): string {
  const uploadDir = getOrderUploadDir();
  const normalizedKey = storageKey.replace(/\\/g, "/");
  if (
    normalizedKey.includes("..") ||
    normalizedKey.startsWith("/") ||
    normalizedKey.includes("\0")
  ) {
    throw new Error("Invalid document storage key.");
  }

  const absolutePath = path.resolve(uploadDir, normalizedKey);
  const relative = path.relative(uploadDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid document storage path.");
  }

  return absolutePath;
}

export async function saveOrderDocument({
  shopId,
  productionOrderId,
  file,
  extension,
}: {
  shopId: string;
  productionOrderId: string;
  file: File;
  extension: string;
}): Promise<{ storageKey: string }> {
  const storageKey = buildOrderDocumentStorageKey({
    shopId,
    productionOrderId,
    extension,
  });
  const absolutePath = resolveOrderDocumentPath(storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);
  return { storageKey };
}

export async function readOrderDocument(
  storageKey: string,
): Promise<Buffer> {
  const absolutePath = resolveOrderDocumentPath(storageKey);
  return readFile(absolutePath);
}

export async function deleteOrderDocument(storageKey: string): Promise<void> {
  const absolutePath = resolveOrderDocumentPath(storageKey);
  try {
    await unlink(absolutePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export function isInlineViewableMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
  );
}

export function buildContentDisposition(
  originalName: string,
  inline: boolean,
): string {
  const safeName = originalName
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${safeName}"`;
}
