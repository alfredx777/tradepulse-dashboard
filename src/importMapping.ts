export type ImportMapping = { role: string; fieldName: string; fieldType: "text" | "number" };

export const STANDARD_HEADER_NAMES = ["product", "customer", "year", "month", "quantity", "total value"];

export const STANDARD_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "customer", label: "Customer" },
  { value: "year", label: "Year" },
  { value: "month", label: "Month" },
  { value: "quantity", label: "Quantity" },
  { value: "total_value", label: "Total Value" },
  { value: "custom", label: "New/custom field" },
  { value: "skip", label: "Skip this column" },
];

export function guessRole(header: string): string | null {
  const h = header.trim().toLowerCase();
  const synonyms: Record<string, string[]> = {
    product: ["product", "item", "product name"],
    customer: ["customer", "client", "buyer"],
    year: ["year"],
    month: ["month"],
    quantity: ["quantity", "qty", "units"],
    total_value: ["total value", "total", "value", "amount", "sales", "revenue"],
  };
  for (const [role, names] of Object.entries(synonyms)) {
    if (names.includes(h)) return role;
  }
  return null;
}
