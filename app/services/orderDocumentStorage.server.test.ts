import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteOrderDocument,
  resolveOrderDocumentPath,
  saveOrderDocument,
} from "./orderDocumentStorage.server";

describe("orderDocumentStorage path safety", () => {
  const previousUploadDir = process.env.ORDER_UPLOAD_DIR;
  let tempDir = "";

  afterEach(async () => {
    if (previousUploadDir === undefined) {
      delete process.env.ORDER_UPLOAD_DIR;
    } else {
      process.env.ORDER_UPLOAD_DIR = previousUploadDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("rejects path traversal in storage keys", () => {
    tempDir = "";
    process.env.ORDER_UPLOAD_DIR = path.join(os.tmpdir(), "ccpm-upload-safe");
    expect(() => resolveOrderDocumentPath("../outside.pdf")).toThrow(
      /Invalid document storage/,
    );
    expect(() => resolveOrderDocumentPath("/abs/path.pdf")).toThrow(
      /Invalid document storage/,
    );
  });

  it("creates nested directories and cleans up deleted files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ccpm-upload-"));
    process.env.ORDER_UPLOAD_DIR = tempDir;
    process.env.NODE_ENV = "test";

    const file = new File([Buffer.from("%PDF-1.4 test")], "order.pdf", {
      type: "application/pdf",
    });

    const saved = await saveOrderDocument({
      shopId: "shop_1",
      productionOrderId: "order_1",
      file,
      extension: ".pdf",
    });

    const absolutePath = resolveOrderDocumentPath(saved.storageKey);
    expect(absolutePath.startsWith(tempDir)).toBe(true);

    await deleteOrderDocument(saved.storageKey);
    await expect(deleteOrderDocument(saved.storageKey)).resolves.toBeUndefined();
  });

  it("survives cleanup when the physical file is already missing", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ccpm-upload-missing-"));
    process.env.ORDER_UPLOAD_DIR = tempDir;

    const storageKey = "shop_1/order_1/missing.pdf";
    const absolutePath = resolveOrderDocumentPath(storageKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "temp");
    await rm(absolutePath);

    await expect(deleteOrderDocument(storageKey)).resolves.toBeUndefined();
  });
});
