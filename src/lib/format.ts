export function fmt(n: number): string {
  return "£" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function isEstimateLabel(label: string): boolean {
  return /\(est\.?\)/i.test(label);
}
