type ImportLogContext = {
  stage?: string;
  shopDomain?: string;
  shopId?: string;
  pdfFilename?: string;
  pdfByteSize?: number;
  orderNumber?: string;
  sku?: string;
  error?: unknown;
};

function serializeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

export function logProductionOrderImport(
  prefix:
    | "[ProductionOrderImport]"
    | "[ProductionOrderPdfParser]"
    | "[ProductionOrderStorage]",
  message: string,
  context: ImportLogContext = {},
): void {
  const { error, ...safeContext } = context;
  const payload: Record<string, unknown> = {
    ...safeContext,
  };

  if (error !== undefined) {
    payload.error = serializeError(error);
  }

  console.error(`${prefix} ${message}`, payload);
}

export function userFacingImportError(
  message: string,
  options?: { isDevelopment?: boolean; detail?: string },
): string {
  const isDevelopment =
    options?.isDevelopment ?? process.env.NODE_ENV !== "production";

  if (isDevelopment && options?.detail) {
    return `${message} (${options.detail})`;
  }

  return message;
}
