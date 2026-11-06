/**
 * 从 1Password 读取 API 凭据：经 Hermes-agent 只读 service account（DPAPI 保护的读取器）。
 *
 * 凭据只留在本进程内存，只发往对应服务的官方 API；不写盘、不进日志、不经命令行参数
 * （命令行只带条目 ID），读取失败只给笼统错误，不转发 stderr。
 * @module dsh-pet/src/host/usage/secrets
 */
import { spawn } from 'node:child_process';

/** 内联读取脚本：argv[1]=读取器目录，argv[2]=条目 ID；只把 credential 字段写到 stdout。 */
const READER_SCRIPT = [
  'import sys',
  'sys.path.insert(0, sys.argv[1])',
  'from hermes_reader import Reader',
  'v = Reader().get_field(sys.argv[2], field_id="credential")',
  'sys.exit(1) if not v else sys.stdout.write(v)',
].join('\n');

/** 读取器参数。 */
export interface SecretReaderOptions {
  /** 运行读取器的 Python。 */
  readonly python: string;
  /** hermes_reader.py 所在目录。 */
  readonly readerDir: string;
}

/**
 * 读一个 1Password 条目的 credential 字段。
 *
 * @param options - 读取器参数。
 * @param itemId - 条目 ID（不是机密）。
 * @returns 凭据值（调用方只放内存）。
 */
export function readOnePasswordCredential(options: SecretReaderOptions, itemId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -I：隔离模式，不让当前目录或用户 site-packages 里的同名模块被导入。
    const child = spawn(options.python, ['-I', '-c', READER_SCRIPT, options.readerDir, itemId], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动 1Password 读取器。'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const value = out.trim();
      if (code === 0 && value) resolve(value);
      else reject(new Error('无法从 1Password 读取凭据。'));
    });
  });
}

/** 惰性凭据：首次用时读取，鉴权失败时调用 forget() 下次重读。 */
export interface LazySecret {
  /** 取凭据。 */
  get(): Promise<string>;
  /** 丢弃缓存的凭据。 */
  forget(): void;
}

/**
 * 包一层惰性缓存；条目或读取器未配置时直接报「未配置」。
 *
 * @param options - 读取器参数（readerDir 为 null 视为未配置）。
 * @param itemId - 条目 ID（null 视为未配置）。
 * @param label - 错误文案里的凭据名。
 * @param read - 读取函数（测试注入）。
 * @returns 惰性凭据。
 */
export function createLazySecret(
  options: { python: string; readerDir: string | null },
  itemId: string | null,
  label: string,
  read: (o: SecretReaderOptions, id: string) => Promise<string> = readOnePasswordCredential,
): LazySecret {
  let cached: string | null = null;
  return {
    async get() {
      if (cached) return cached;
      if (!options.readerDir || !itemId) throw new Error(`未配置 ${label} 的 1Password 条目。`);
      cached = await read({ python: options.python, readerDir: options.readerDir }, itemId).catch(() => {
        throw new Error(`无法从 1Password 读取 ${label}。`);
      });
      return cached;
    },
    forget() {
      cached = null;
    },
  };
}
