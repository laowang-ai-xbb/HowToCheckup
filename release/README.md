# v1.0 存在性证明

这个目录不是产品的一部分，是**"这份代码什么时候写的"的证据**。别人抄走代码，靠的不是律师函，是先后顺序。

## 里面有什么

| 文件 | 是什么 |
|---|---|
| `timestamp-v1.0.txt` | 一页纸：tag、commit、tree、文件数、许可、记录时间 |
| `timestamp-v1.0.txt.sha256` | 上面那页纸的 sha256（64 位十六进制） |
| `timestamp-v1.0.txt.ots.btc.calendar.catallaxy.com` | 提交给 OpenTimestamps 日历拿到的回执（`btc.calendar.catallaxy.com`） |
| `timestamp-v1.0.txt.ots.finney.calendar.eternitywall.com` | 同上，另一家日历（多家互为备份，一家倒了不影响） |

## 现在的状态

两份回执都是 **pending（待确认）**：日历已经收下并用自己的日志记下了这个摘要，但要等它被打包进一笔比特币交易、再等交易上链，才会变成"可用区块链独立验证"的完整证明。通常几小时。

**回执不能手改，也不要在意它现在打不开** —— 它绑定的摘要（`timestamp-v1.0.txt.sha256`）已经固定，内容一个字节都不能动，动了证明就作废。

## 想把它做完（任何一台机器，几分钟）

```bash
pip install opentimestamps-client
ots upgrade release/timestamp-v1.0.txt.ots.<日历域名>   # 等上链后再跑，会补上比特币区块
ots verify release/timestamp-v1.0.txt.ots.<日历域名>    # 输出该区块的高度与时间
```

或者把 `timestamp-v1.0.txt` 传到 <https://opentimestamps.org/>，网站会直接返回完整的 `.ots`。

## 更硬的一张纸（涉及打官司时）

OpenTimestamps 证明的是"时刻"，法院更认**联合信任时间戳服务中心（tsa.cn）** 出的 RFC3161 时间戳，一次几块钱，把 `timestamp-v1.0.txt` 上传即可。再往上就是**软件著作权登记**（中国版权保护中心，官费已取消，周期约 60 个工作日），那是最硬的一份。

## 提醒

- 这三样东西的价值全部来自"**先**"。晚一天，就少一天的确定性。
- `timestamp-v1.0.txt` 一旦提交过时间戳，**不要再改**。要打新版本的时间戳，另存 `timestamp-v1.1.txt`。

## 关于提交哈希

`timestamp-v1.0.txt` 里记录的 commit `df64926` 是 v1.0 打标签时的原始提交。开源发布前做过一次历史整理（设计稿、一次性迁移脚本与软著申请材料移出仓库），提交历史合并为单个初始提交，原哈希不再出现在本仓库历史里。时间戳锚定的是当时的**文件内容哈希**（tree 哈希与 release 目录的 sha256），证据效力不受影响。
