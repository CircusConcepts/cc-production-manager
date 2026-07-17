import {
  getMaxOrderDocumentBytes,
  type ValidatedOrderDocument,
} from "./orderDocumentStorage.server";
import {
  CIRCUS_ORDER_PDF_PARSER_VERSION,
  parseCircusOrderPdf,
  type ParsedCircusOrderPdf,
} from "./circusOrderPdfParser.server";
import {
  checkDuplicateProductionOrderNumber,
  createProductionOrderFromParsedPdf,
  resolveParsedPdfLinesForShop,
  type ResolvedPdfImportLine,
} from "./productionOrder.server";
import {
  logProductionOrderImport,
  userFacingImportError,
} from "./productionOrderImportLog.server";

export type OrderPdfPreviewLine = {
  sku: string;
  productName: string;
  quantity: number;
  colorName: string | null;
  size: string | null;
  options: Array<{ label: string; value: string }>;
  pdfDescription: string;
};

export type OrderPdfPreview = {
  orderNumber: string;
  orderDate: string;
  customerName: string;
  customerAddress: string;
  shippingMethod: string | null;
  pdfFilename: string;
  lines: OrderPdfPreviewLine[];
  parserVersion: string;
};

export type OrderPdfPreviewResult =
  | { ok: true; preview: OrderPdfPreview }
  | { ok: false; error: string; status?: number };

export type OrderPdfCreateResult =
  | {
      ok: true;
      order: { id: string };
    }
  | { ok: false; error: string; status?: number };

export async function validateOrderPdfUpload(
  file: unknown,
): Promise<
  | { ok: true; file: File; buffer: Buffer }
  | { ok: false; error: string; status: number }
> {
  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      error: "A PDF order file is required.",
      status: 400,
    };
  }

  const maxBytes = getMaxOrderDocumentBytes();
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: "The PDF must be 10 MB or smaller.",
      status: 400,
    };
  }

  const filename = file.name.trim().toLowerCase();
  if (!filename.endsWith(".pdf")) {
    return {
      ok: false,
      error: "Only PDF files are accepted.",
      status: 400,
    };
  }

  if (file.type && file.type !== "application/pdf") {
    return {
      ok: false,
      error: "Only PDF files are accepted.",
      status: 400,
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return {
      ok: false,
      error: "The uploaded file is not a valid PDF.",
      status: 400,
    };
  }

  return { ok: true, file, buffer };
}

function buildPreview(
  parsed: ParsedCircusOrderPdf,
  resolvedLines: ResolvedPdfImportLine[],
  pdfFilename: string,
): OrderPdfPreview {
  return {
    orderNumber: parsed.orderNumber,
    orderDate: parsed.orderDate,
    customerName: parsed.customerName,
    customerAddress: parsed.customerAddress,
    shippingMethod: parsed.shippingMethod,
    pdfFilename,
    parserVersion: CIRCUS_ORDER_PDF_PARSER_VERSION,
    lines: resolvedLines.map((line) => ({
      sku: line.sku,
      productName: line.productName,
      quantity: line.quantity,
      colorName: line.colorName,
      size: line.size,
      options: line.options,
      pdfDescription: line.pdfDescription,
    })),
  };
}

export async function previewOrderPdfImport({
  shopId,
  shopDomain,
  manualOrderNumber,
  pdfFile,
}: {
  shopId: string;
  shopDomain?: string;
  manualOrderNumber: string;
  pdfFile: File;
}): Promise<OrderPdfPreviewResult> {
  const validation = await validateOrderPdfUpload(pdfFile);
  if (!validation.ok) {
    return validation;
  }

  let parsed;
  try {
    parsed = await parseCircusOrderPdf(
      validation.buffer,
      manualOrderNumber,
    );
  } catch (error) {
    logProductionOrderImport(
      "[ProductionOrderPdfParser]",
      "Unexpected PDF parse failure during preview.",
      {
        stage: "parse_pdf_preview",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: manualOrderNumber,
        error,
      },
    );
    return {
      ok: false,
      status: 500,
      error: userFacingImportError(
        "Could not read the order PDF. Please try again.",
        {
          detail: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }

  if (!parsed.ok) {
    logProductionOrderImport(
      "[ProductionOrderPdfParser]",
      "PDF parse rejected during preview.",
      {
        stage: "parse_pdf_preview_validation",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: manualOrderNumber,
        error: parsed.error,
      },
    );
    return { ok: false, error: parsed.error, status: 422 };
  }

  const duplicate = await checkDuplicateProductionOrderNumber(
    shopId,
    parsed.data.orderNumber,
  );
  if (duplicate) {
    return { ...duplicate, status: 422 };
  }

  const resolved = await resolveParsedPdfLinesForShop({
    shopId,
    lines: parsed.data.lines,
  });
  if (!resolved.ok) {
    logProductionOrderImport(
      "[ProductionOrderImport]",
      "Product/color resolution failed during preview.",
      {
        stage: "resolve_lines_preview",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: parsed.data.orderNumber,
        sku: parsed.data.lines.map((line) => line.sku).join(", "),
        error: resolved.error,
      },
    );
    return { ok: false, error: resolved.error, status: 422 };
  }

  return {
    ok: true,
    preview: buildPreview(
      parsed.data,
      resolved.lines,
      pdfFile.name.trim() || "order.pdf",
    ),
  };
}

export async function createOrderPdfImport({
  shopId,
  shopDomain,
  manualOrderNumber,
  pdfFile,
}: {
  shopId: string;
  shopDomain?: string;
  manualOrderNumber: string;
  pdfFile: File;
}): Promise<OrderPdfCreateResult> {
  const validation = await validateOrderPdfUpload(pdfFile);
  if (!validation.ok) {
    return validation;
  }

  let parsed;
  try {
    parsed = await parseCircusOrderPdf(
      validation.buffer,
      manualOrderNumber,
    );
  } catch (error) {
    logProductionOrderImport(
      "[ProductionOrderPdfParser]",
      "Unexpected PDF parse failure during create.",
      {
        stage: "parse_pdf_create",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: manualOrderNumber,
        error,
      },
    );
    return {
      ok: false,
      status: 500,
      error: userFacingImportError(
        "Could not create the production order. Please try again.",
        {
          detail: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }

  if (!parsed.ok) {
    logProductionOrderImport(
      "[ProductionOrderPdfParser]",
      "PDF parse rejected during create.",
      {
        stage: "parse_pdf_create_validation",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: manualOrderNumber,
        error: parsed.error,
      },
    );
    return { ok: false, error: parsed.error, status: 422 };
  }

  const duplicate = await checkDuplicateProductionOrderNumber(
    shopId,
    parsed.data.orderNumber,
  );
  if (duplicate) {
    return { ...duplicate, status: 422 };
  }

  const resolved = await resolveParsedPdfLinesForShop({
    shopId,
    lines: parsed.data.lines,
  });
  if (!resolved.ok) {
    logProductionOrderImport(
      "[ProductionOrderImport]",
      "Product/color resolution failed during create.",
      {
        stage: "resolve_lines_create",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: parsed.data.orderNumber,
        sku: parsed.data.lines.map((line) => line.sku).join(", "),
        error: resolved.error,
      },
    );
    return { ok: false, error: resolved.error, status: 422 };
  }

  const pdfDocument: ValidatedOrderDocument = {
    file: pdfFile,
    mimeType: "application/pdf",
    extension: ".pdf",
  };

  try {
    const created = await createProductionOrderFromParsedPdf({
      shopId,
      parsed: parsed.data,
      resolvedLines: resolved.lines,
      pdfDocument,
    });

    if (!created.ok) {
      return { ok: false, error: created.error, status: 422 };
    }

    return { ok: true, order: { id: created.order.id } };
  } catch (error) {
    logProductionOrderImport(
      "[ProductionOrderImport]",
      "Unexpected failure while creating order from PDF.",
      {
        stage: "create_order_from_pdf",
        shopId,
        shopDomain,
        pdfFilename: pdfFile.name,
        pdfByteSize: pdfFile.size,
        orderNumber: parsed.data.orderNumber,
        error,
      },
    );
    return {
      ok: false,
      status: 500,
      error: userFacingImportError(
        "Could not create the production order. Please try again.",
        {
          detail: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }
}

export function readOrderPdfFromFormData(
  formData: FormData,
): File | null {
  const file = formData.get("orderPdf");
  return file instanceof File && file.size > 0 ? file : null;
}
