# AI 马来语私人教师（PWA）

上传老师的 PPTX / PDF 课件，AI 逐页生成中文讲义，并像真人老师一样：用中文讲解、用马来西亚标准马来语（ms-MY）示范发音、带读、提问、纠错。支持电脑浏览器和 iPhone（可“添加到主屏幕”）。

## 功能

| 模块 | 说明 |
|---|---|
| 上传课件 | PPTX（按真实放映顺序提取每页文字、表格、演讲者备注、图片）/ PDF（逐页文字 + 整份 PDF 交给 AI 识读版面与图片），保留原始页码 |
| 讲义 | 每页：课件原文、单词（释义/词性/发音提示/例句）、句型、语法、记忆技巧。每条内容都标注 **课件** 或 **AI补充** |
| 上课 | 按页顺序引导教学：讲解 → 示范 → 带读 → 提问 → 纠错，每次只讲一个小点；对话自动保存，可随时继续 |
| 发音 | 标准 / 慢速播放（Azure ms-MY 神经语音），录音跟读，Azure 发音评测（总分、准确度、流利度、完整度、逐词标错） |
| 口语测试 | AI 用中文提问，你用马来语语音回答，AI 检查表达和语法、指出错误、引导重试 |
| 听力测试 | AI 用马来语提问，**默认隐藏字幕**，你语音回答，AI 判断是否听懂 |
| 复习 | 自动记录每个知识点的对错、错误原因；间隔重复（答错 10 分钟后重考，答对后 1/3/7/16 天）安排复习，列出薄弱点和最近错误 |

没有任何假数据或模拟反馈：未配置 API Key 时，相关功能会明确提示“未配置”，而不是返回伪造结果。

## 技术栈

- 后端：Node.js 20+ / Express（API Key 只在服务端，前端拿不到）
- AI：Anthropic Claude（默认 `claude-opus-5-5`，结构化 JSON 输出）
- 语音：Azure AI Speech —— TTS `ms-MY-YasminNeural` / `ms-MY-OsmanNeural`，STT `ms-MY`，发音评测
- 前端：原生 JS PWA（无需构建），浏览器端录音并编码为 16kHz WAV
- 存储：`data/` 目录下的 JSON 文件（课程、进度、错题、语音缓存），自动保存

## 需要配置的 API Key

复制 `.env.example` 为 `.env` 并填写：

| 变量 | 必填 | 获取方式 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | https://console.anthropic.com → API Keys |
| `AZURE_SPEECH_KEY` | 是 | Azure 门户创建 “Speech service / 语音服务” 资源 → 密钥和终结点 |
| `AZURE_SPEECH_REGION` | 是 | 该资源的区域，例如 `southeastasia`（新加坡，离马来西亚近） |
| `CLAUDE_MODEL` | 否 | 默认 `claude-opus-5-5`；想省钱可改为 `claude-sonnet-5-5` |
| `APP_PASSWORD` | 否 | 设置后打开网页需要输入密码。部署到公网时务必设置，防止他人消耗你的 API 额度 |
| `PORT` / `DATA_DIR` | 否 | 默认 `3000` / `./data` |

Azure 语音有免费层（F0），个人学习通常够用。

## 启动

```bash
npm install
```

```bash
cp .env.example .env   # 然后编辑 .env 填入 Key
```

```bash
npm start
```

打开 http://localhost:3000 。

### 在 iPhone 上使用

iPhone 的 Safari 只允许在 **HTTPS** 页面里使用麦克风，所以需要一个 HTTPS 地址：

- 临时方式：在电脑上运行服务后，用 Cloudflare Tunnel 生成一个 https 链接：

  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```

  用 iPhone Safari 打开输出的 `https://xxxx.trycloudflare.com`。
- 长期方式：部署到任意支持 Node.js 的服务器 / 云平台（Render、Railway、VPS 等），并挂上 HTTPS；记得设置 `APP_PASSWORD`，并让 `DATA_DIR` 指向持久化磁盘。

打开后点 Safari 的“分享 → 添加到主屏幕”，即可像 App 一样全屏使用。首次录音会请求麦克风权限；请关闭静音开关以听到老师的声音。

## 使用流程

1. 首页上传课件 → 自动解析并在后台逐页生成讲义（已生成的页可以先学）。
2. “上课”：点“开始上课”，老师讲解并示范；轮到你时点麦克风（或开启“老师说完自动开始录音”），说完自动停止。
3. “发音”：逐个单词/句子听标准音、慢速音，跟读看评分。
4. “口语测试” / “听力测试”：选范围和题数，AI 根据课件出题、批改、引导重试。
5. “复习”：系统根据错题和遗忘曲线安排的复习题。

## 测试

```bash
npm test
```

单元测试覆盖 PPTX/PDF 解析（页码、备注、图片）、间隔复习算法、文本比对。`test/mock-anthropic.mjs` 是**仅供自动化测试**的 Anthropic API 模拟服务，用来校验请求格式和界面流程，应用运行时不会使用它。

## 目录

```
server/   index.js 路由与讲义生成队列 · parse.js 课件解析 · ai.js Claude 调用与提示词
          speech.js Azure 语音 · progress.js 进度/复习 · store.js 存储
public/   index.html · app.js 界面 · audio.js 播放与录音 · sw.js / manifest PWA
test/     单元测试与样例课件
```

## 说明与限制

- 旧版 `.ppt` 需先在 PowerPoint/WPS 中另存为 `.pptx`。
- 扫描版 PDF：文字层为空时，AI 会直接阅读附带的 PDF 页面图像（PDF ≤ 20MB）。PPTX 中每页最多 4 张图片会交给 AI 识读。
- 语音识别对单个短词有时会误识别，AI 批改时会结合发音评分判断，并在可能是识别误差时提示。
- Azure 发音评测若在你的区域对 ms-MY 不可用，系统会明确提示，并改为基于真实识别结果的逐词比对。
