// Linux 凭据加密存储；参考 DomenLee/toSub2 的账号绑定信封，密钥与数据必须一起备份
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function createFileCredentialStore(root) {
  const keyPath = path.join(root, "credential-key");
  const identity = email => String(email || "").trim().toLowerCase();
  const filename = email => path.join(root, `${crypto.createHash("sha256").update(identity(email)).digest("hex")}.json`);
  async function readKey(create) {
    let key;
    try { key = await fs.readFile(keyPath); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw new Error("凭据加密密钥缺失或无法读取，请恢复完整备份");
      // 已有密文时不重新生成密钥，避免把缺失密钥误当作首次安装
      const entries = await fs.readdir(root);
      if (entries.some(name => name.endsWith(".json"))) return readKey(false);
      key = crypto.randomBytes(32);
      const temporary = `${keyPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, key, { mode: 0o600, flag: "wx" });
        // 完整写入后原子创建链接，避免并发初始化读到尚未写完的密钥
        try { await fs.link(temporary, keyPath); }
        catch (writeError) {
          if (writeError.code !== "EEXIST") throw writeError;
          key = await fs.readFile(keyPath);
        }
      } finally { await fs.rm(temporary, { force: true }); }
    }
    if (key.length !== 32) throw new Error("凭据加密密钥无效，已保留现有文件");
    return key;
  }
  return {
    async save(email, payload) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const key = await readKey(true);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(identity(email)));
      const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
      const target = filename(email);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async load(email) {
      let saved;
      try { saved = JSON.parse(await fs.readFile(filename(email), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw new Error("凭据文件损坏，请恢复完整备份"); }
      const key = await readKey(false);
      try {
        if (saved.version !== 1) throw new Error("Unsupported envelope");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(saved.iv, "base64"));
        decipher.setAAD(Buffer.from(identity(email)));
        decipher.setAuthTag(Buffer.from(saved.tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(saved.data, "base64")), decipher.final()]).toString("utf8");
      } catch { throw new Error("凭据无法解密，请恢复配套密钥和数据"); }
    },
    async delete(email) { await fs.rm(filename(email), { force: true }); },
  };
}
