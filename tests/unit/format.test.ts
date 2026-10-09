import { describe, expect, it } from "vitest";
import { formatFileSize, formatNumber, formatVolume, formatWeight } from "@/lib/format";

const nbsp = (v: string) => v.replace(/ | /g, " ");

describe("Форматирование чисел и единиц измерения", () => {
  it("formatNumber: пусто/NaN — прочерк, иначе разряды через пробел", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(NaN)).toBe("—");
    expect(nbsp(formatNumber(1234.5, 1))).toBe("1 234,5");
  });

  it("formatWeight: килограммы до 1000, затем тонны", () => {
    expect(formatWeight(null)).toBe("—");
    expect(formatWeight(500)).toBe("500 кг");
    expect(formatWeight(1500)).toBe("1,5 т");
  });

  it("formatVolume: кубометры с одним знаком после запятой", () => {
    expect(formatVolume(undefined)).toBe("—");
    expect(formatVolume(12.34)).toBe("12,3 м³");
  });

  it("formatFileSize: байты, килобайты, мегабайты", () => {
    expect(formatFileSize(500)).toBe("500 Б");
    expect(formatFileSize(2048)).toBe("2 КБ");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5 МБ");
  });
});
