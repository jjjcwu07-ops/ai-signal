# AI Signal · 部署说明

每天早上 8 点自动生成，任何人打开网址都能看到最新日报。

---

## 第一步：上传代码到 GitHub

1. 打开 [github.com](https://github.com)，点右上角 **+** → **New repository**
2. 仓库名填 `ai-signal`，选 **Public**，点 **Create repository**
3. 按页面提示，把这个文件夹上传上去：

```bash
cd ai-signal
git init
git add .
git commit -m "初始化 AI Signal"
git remote add origin https://github.com/你的用户名/ai-signal.git
git push -u origin main
```

---

## 第二步：设置 API Key

1. 打开你的 GitHub 仓库页面
2. 点 **Settings** → 左侧 **Secrets and variables** → **Actions**
3. 点 **New repository secret**
4. Name 填：`ANTHROPIC_API_KEY`
5. Value 填：你的 API Key（sk-ant-...）
6. 点 **Add secret**

---

## 第三步：连接 Netlify

1. 打开 [netlify.com](https://netlify.com)，注册/登录
2. 点 **Add new site** → **Import an existing project**
3. 选 GitHub，授权后找到 `ai-signal` 仓库
4. 配置：
   - **Build command**：留空
   - **Publish directory**：`docs`
5. 点 **Deploy site**

部署完成后，Netlify 会给你一个地址（如 `ai-signal-xxx.netlify.app`），可以在 Site settings 里改成自定义名称。

---

## 第四步：手动触发第一次生成

1. 打开 GitHub 仓库，点顶部 **Actions** 标签
2. 左侧选 **每日生成 AI Signal 日报**
3. 点右侧 **Run workflow** → **Run workflow**
4. 等 1-2 分钟，刷新页面看到绿色勾就完成了

之后每天早上 8 点（北京时间）自动运行，你什么都不用做。

---

## 之后改动

- **改页面样式**：编辑 `templates/base.html`
- **改摘要风格**：编辑 `prompts/summarize-tweets.md`
- 改完 push 到 GitHub，下次生成自动用新版本

---

## 费用参考

- GitHub：免费
- Netlify：免费
- Anthropic API：每期约 $0.05-0.10，一个月约 ¥10-20
