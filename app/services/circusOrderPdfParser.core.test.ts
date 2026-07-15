import { describe, expect, it } from "vitest";

import {
  buildLinesFromLayout,
  normalizeOrderNumberInput,
  parseCircusOrderFromTextLines,
} from "./circusOrderPdfParser.core";

function buildSampleInvoiceLayout(options?: {
  orderNumber?: string;
  orderDate?: string;
  customerName?: string;
  addressLines?: string[];
  productDescription?: string[];
  skuLines?: string[];
  quantity?: string;
  model?: string;
  includePaymentAddress?: boolean;
  secondProduct?: {
    description: string[];
    sku: string;
    quantity: string;
    model?: string;
  };
}) {
  const orderNumber = options?.orderNumber ?? "29086";
  const orderDate = options?.orderDate ?? "15/07/2026";
  const customerName = options?.customerName ?? "Veronica Chelu";
  const addressLines = options?.addressLines ?? [
    "306-3440 Durocher",
    "Montreal H2X 2E2",
    "Quebec",
    "Canada",
  ];
  const productDescription = options?.productDescription ?? [
    "Hand Training Trapeze Bar",
  ];
  const skuLines = options?.skuLines ?? ["( SKU : CC-HAND-TRAINING-18-STD)"];
  const quantity = options?.quantity ?? "1";
  const model = options?.model ?? "CEXX";

  const rows: Array<{
    page?: number;
    y: number;
    segments: Array<{ text: string; x: number }>;
  }> = [
    { y: 800, segments: [{ text: `ORDER (#${orderNumber})`, x: 220 }] },
    {
      y: 760,
      segments: [
        { text: "Order ID:", x: 40 },
        { text: orderNumber, x: 110 },
      ],
    },
    {
      y: 740,
      segments: [
        { text: "Date Added", x: 40 },
        { text: orderDate, x: 120 },
      ],
    },
  ];

  if (options?.includePaymentAddress !== false) {
    rows.push({
      y: 680,
      segments: [{ text: "Payment Address", x: 40 }],
    });
  }

  rows.push({
    y: 680,
    segments: [{ text: "Shipping Address", x: 320 }],
  });

  if (options?.includePaymentAddress !== false) {
    rows.push({
      y: 650,
      segments: [{ text: "Different Payer", x: 40 }],
    });
  }

  rows.push({
    y: 650,
    segments: [{ text: customerName, x: 320 }],
  });

  let addressY = 630;
  for (const line of addressLines) {
    rows.push({
      y: addressY,
      segments: [{ text: line, x: 320 }],
    });
    addressY -= 20;
  }

  rows.push({
    y: 500,
    segments: [
      { text: "Product", x: 40 },
      { text: "Model", x: 260 },
      { text: "Quantity", x: 340 },
      { text: "Unit Price", x: 400 },
      { text: "Total", x: 470 },
    ],
  });

  let productY = 470;
  productDescription.forEach((line, index) => {
    rows.push({
      y: productY,
      segments: [
        { text: line, x: 40 },
        ...(index === 0
          ? [
              { text: model, x: 260 },
              { text: quantity, x: 340 },
              { text: "$100.00", x: 400 },
              { text: "$100.00", x: 470 },
            ]
          : []),
      ],
    });
    productY -= 15;
  });

  for (const line of skuLines) {
    rows.push({
      y: productY,
      segments: [{ text: line, x: 40 }],
    });
    productY -= 15;
  }

  if (options?.secondProduct) {
    productY -= 10;
    options.secondProduct.description.forEach((line, index) => {
      rows.push({
        y: productY,
        segments: [
          { text: line, x: 40 },
          ...(index === 0
            ? [
                { text: options.secondProduct?.model ?? "CEYY", x: 260 },
                { text: options.secondProduct?.quantity ?? "1", x: 340 },
                { text: "$50.00", x: 400 },
                { text: "$50.00", x: 470 },
              ]
            : []),
        ],
      });
      productY -= 15;
    });
    rows.push({
      y: productY,
      segments: [{ text: `( SKU : ${options.secondProduct.sku})`, x: 40 }],
    });
    productY -= 15;
  }

  rows.push({
    y: 300,
    segments: [{ text: "Sub-Total", x: 40 }],
  });

  return buildLinesFromLayout(rows);
}

describe("normalizeOrderNumberInput", () => {
  it("trims whitespace and removes an optional leading hash", () => {
    expect(normalizeOrderNumberInput("  #29086 ")).toBe("29086");
    expect(normalizeOrderNumberInput("29086")).toBe("29086");
  });
});

describe("parseCircusOrderFromTextLines", () => {
  it("parses a sample-style single product invoice", () => {
    const lines = buildSampleInvoiceLayout();
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orderNumber).toBe("29086");
    expect(result.data.orderDate).toBe("2026-07-15");
    expect(result.data.customerName).toBe("Veronica Chelu");
    expect(result.data.customerAddress).toContain("Montreal H2X 2E2");
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.lines[0]?.sku).toBe("CC-HAND-TRAINING-18-STD");
    expect(result.data.lines[0]?.quantity).toBe(1);
  });

  it("parses multiple products", () => {
    const lines = buildSampleInvoiceLayout({
      secondProduct: {
        description: ["Second Product"],
        sku: "CC-SECOND-SKU",
        quantity: "2",
      },
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines).toHaveLength(2);
    expect(result.data.lines[1]?.sku).toBe("CC-SECOND-SKU");
    expect(result.data.lines[1]?.quantity).toBe(2);
  });

  it("joins SKUs wrapped across lines", () => {
    const lines = buildSampleInvoiceLayout({
      skuLines: ["( SKU : CC-HAND-", "TRAINING-18-STD)"],
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]?.sku).toBe("CC-HAND-TRAINING-18-STD");
  });

  it("supports tables spanning multiple pages", () => {
    const pageOne = buildSampleInvoiceLayout({
      secondProduct: {
        description: ["Second Product"],
        sku: "CC-SECOND-SKU",
        quantity: "2",
      },
    });

    const pageTwo = buildLinesFromLayout([
      {
        page: 1,
        y: 500,
        segments: [
          { text: "Product", x: 40 },
          { text: "Model", x: 260 },
          { text: "Quantity", x: 340 },
          { text: "Unit Price", x: 400 },
          { text: "Total", x: 470 },
        ],
      },
      {
        page: 1,
        y: 470,
        segments: [
          { text: "Third Product", x: 40 },
          { text: "CEZZ", x: 260 },
          { text: "3", x: 340 },
          { text: "$30.00", x: 400 },
          { text: "$90.00", x: 470 },
        ],
      },
      {
        page: 1,
        y: 455,
        segments: [{ text: "( SKU : CC-THIRD-SKU)", x: 40 }],
      },
      {
        page: 1,
        y: 300,
        segments: [{ text: "Sub-Total", x: 40 }],
      },
    ]);

    const result = parseCircusOrderFromTextLines([...pageOne, ...pageTwo], {
      manualOrderNumber: "29086",
      pageCount: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines).toHaveLength(3);
    expect(result.data.lines[2]?.sku).toBe("CC-THIRD-SKU");
  });

  it("uses shipping address instead of payment address", () => {
    const lines = buildSampleInvoiceLayout();
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customerName).toBe("Veronica Chelu");
    expect(result.data.customerName).not.toBe("Different Payer");
  });

  it("rejects mismatched ORDER number and Order ID", () => {
    const lines = buildSampleInvoiceLayout({ orderNumber: "29086" });
    const headerLine = lines.find((line) => line.text.includes("ORDER (#"));
    if (headerLine) {
      headerLine.text = "ORDER (#99999)";
      headerLine.items[0].text = "ORDER (#99999)";
    }

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("do not match");
  });

  it("rejects a manual order number mismatch", () => {
    const lines = buildSampleInvoiceLayout();
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "12345",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("does not match");
  });

  it("rejects a missing SKU", () => {
    const lines = buildSampleInvoiceLayout({ skuLines: [] });
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("sku");
  });

  it("rejects multiple SKUs in one row", () => {
    const lines = buildSampleInvoiceLayout({
      skuLines: [
        "( SKU : CC-HAND-TRAINING-18-STD)",
        "( SKU : CC-OTHER-SKU)",
      ],
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("multiple SKU");
  });

  it("rejects invalid quantity", () => {
    const lines = buildSampleInvoiceLayout({ quantity: "0" });
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects missing Shipping Address", () => {
    const lines = buildLinesFromLayout([
      { y: 800, segments: [{ text: "ORDER (#29086)", x: 220 }] },
      {
        y: 760,
        segments: [
          { text: "Order ID:", x: 40 },
          { text: "29086", x: 110 },
        ],
      },
      {
        y: 740,
        segments: [
          { text: "Date Added", x: 40 },
          { text: "15/07/2026", x: 120 },
        ],
      },
      {
        y: 500,
        segments: [
          { text: "Product", x: 40 },
          { text: "Quantity", x: 340 },
          { text: "Total", x: 470 },
        ],
      },
    ]);

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Shipping Address");
  });

  it("rejects missing Date Added", () => {
    const lines = buildSampleInvoiceLayout();
    const filtered = lines.filter((line) => !line.text.includes("Date Added"));
    const result = parseCircusOrderFromTextLines(filtered, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Date Added");
  });

  it("rejects invalid calendar dates", () => {
    const lines = buildSampleInvoiceLayout({ orderDate: "31/02/2026" });
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Date Added");
  });

  it("rejects PDFs without a text layer", () => {
    const result = parseCircusOrderFromTextLines([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("text layer");
  });

  it("does not treat summary rows as products", () => {
    const lines = buildSampleInvoiceLayout();
    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines.every((line) => line.sku.startsWith("CC-"))).toBe(
      true,
    );
  });

  it("parses explicit Color options", () => {
    const lines = buildSampleInvoiceLayout({
      skuLines: [
        "( SKU : CC-HAND-TRAINING-18-STD)",
        "Color: Red",
      ],
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]?.colorName).toBe("Red");
  });

  it("parses explicit Size options", () => {
    const lines = buildSampleInvoiceLayout({
      skuLines: [
        "( SKU : CC-HAND-TRAINING-18-STD)",
        "Size: Large",
      ],
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]?.size).toBe("Large");
  });

  it("keeps non-size options in customProperties options", () => {
    const lines = buildSampleInvoiceLayout({
      skuLines: [
        "( SKU : CC-HAND-TRAINING-18-STD)",
        "Training Canes Length: 18'' Training",
      ],
    });

    const result = parseCircusOrderFromTextLines(lines, {
      manualOrderNumber: "29086",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]?.size).toBeNull();
    expect(result.data.lines[0]?.options).toEqual([
      {
        label: "Training Canes Length",
        value: "18'' Training",
      },
    ]);
  });
});
