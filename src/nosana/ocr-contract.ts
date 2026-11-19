// Expected identity of this public benchmark. Model commits and source versions
// must match containers/ocr-benchmark/bench.py; regression tests enforce that.
export const OCR_OPERATION_ID = "ocr-daily-benchmark";
export const OCR_PAGE_COUNT = 22;
export const OCR_MODELS = [
  { model: "nanonets/Nanonets-OCR2-1.5B-exp", revision: "49a96f20ac641c7b3ad811914968ea8e1ace1760" },
  { model: "nanonets/Nanonets-OCR2-3B", revision: "c3886ff00bb037ce7da24988c9eafaf1fe2bed72" },
] as const;
export const OCR_SOURCES = [
  "https://arxiv.org/pdf/1706.03762v7",
  "https://arxiv.org/pdf/2005.14165v4",
  "https://arxiv.org/pdf/1512.03385v1",
] as const;
