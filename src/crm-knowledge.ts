import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CRM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skill/references/crm");

export async function getCrmFieldDictionary(): Promise<unknown> {
  const [dictionary, relations, guide] = await Promise.all([
    fs.readFile(path.join(CRM_DIR, "crm-key-field-dictionary.json"), "utf8"),
    fs.readFile(path.join(CRM_DIR, "crm-enums-and-relations.json"), "utf8"),
    fs.readFile(path.join(CRM_DIR, "CRM字段字典与分析映射.md"), "utf8"),
  ]);
  return { dictionary: JSON.parse(dictionary), relations: JSON.parse(relations), guide };
}

export async function getCrmObjectMetadata(apiKey: string): Promise<unknown> {
  const metadata = JSON.parse(await fs.readFile(path.join(CRM_DIR, "crm-field-metadata-full.json"), "utf8")) as Array<{ apiKey: string; response: unknown }>;
  const object = metadata.find(item => item.apiKey === apiKey);
  if (!object) throw new Error(`未知 CRM 对象: ${apiKey}`);
  return object.response;
}
