/* 对抗负例测试：故意把条款卡字段填错，校验器必须报错。
 * 校验器本身也是代码——它"查不出错"和"规则错了"同样危险，
 * 所以这里用"已知错误必须被抓到"来反向证明校验器有效。
 *
 * 原理：把 data/rules.json 复制到临时文件，逐个注入错误，
 * 用 `node scripts/validate.mjs --rules <tmp>` 跑，断言退出码非 0 且报错信息命中。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const rules = JSON.parse(readFileSync(join(root, 'data/rules.json'), 'utf8'));

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`ok   ${name}`); }
  else { fails.push(name); console.log(`FAIL ${name} — ${detail}`); }
};

const runWith = (mutate) => {
  const copy = JSON.parse(JSON.stringify(rules));
  mutate(copy);
  const dir = mkdtempSync(join(tmpdir(), 'vneg-'));
  const file = join(dir, 'rules.json');
  writeFileSync(file, JSON.stringify(copy), 'utf8');
  const out = spawnSync(process.execPath, [join(root, 'scripts/validate.mjs'), '--rules', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { code: out.status, out: (out.stdout || '') + (out.stderr || '') };
};

const ldct = (doc) => doc.rules.find((r) => r.id === 'lung-ldct-high-risk');

// 0. 对照组：不改任何东西，校验器必须通过
{
  const { code, out } = runWith(() => {});
  check('对照：未篡改的规则文件校验通过', code === 0, out.slice(-300));
}
// 1. 人群数字与原文不符：把 50 岁起筛改成 40 岁（USPSTF 原文是 50–80；合并进来的中华医学会引文里有 45，所以 45 不再是"无出处"数字，2026-11-26 换成 40）
{
  const { code, out } = runWith((d) => { ldct(d).clause.population.include[0] = '年龄 40–80 岁'; });
  check('数字回读：40 这个原文没有的年龄被抓到', code !== 0 && /40/.test(out) && /没有出处/.test(out), out.slice(-300));
}
// 2. 枚举非法：conflictPolicy 填了不在枚举里的值
{
  const { code, out } = runWith((d) => { ldct(d).clause.conflictPolicy = 'random-guess'; });
  check('枚举：非法 conflictPolicy 被抓到', code !== 0 && /conflictPolicy/.test(out), out.slice(-300));
}
// 3. 版本号张冠李戴：version 写成 2018
{
  const { code, out } = runWith((d) => { ldct(d).clause.version = '2018'; });
  check('版本：原文出处里没有的 version 被抓到', code !== 0 && /version/.test(out), out.slice(-300));
}
// 4. 幽灵版本：supersedes 指向不存在的规则
{
  const { code, out } = runWith((d) => { ldct(d).clause.supersedes = 'no-such-rule-id'; });
  check('supersedes：指向不存在的规则被抓到', code !== 0 && /supersedes/.test(out), out.slice(-300));
}
// 5. 缺字段：删掉 followup_path
{
  const { code, out } = runWith((d) => { delete ldct(d).clause.followup_path; });
  check('缺字段：删 followup_path 被抓到', code !== 0 && /followup_path/.test(out), out.slice(-300));
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) process.exit(1);
