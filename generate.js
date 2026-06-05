// ============================================================================
// AI Signal — Daily Report Generator
// 每天自动拉取 Builder 数据，调用 Claude API 生成摘要，渲染成 HTML
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs');

// ── 数据源（直接用 Zara 维护的中心化 feed）──
const FEED_X_URL       = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL= 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL   = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS_BASE     = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';

// ── Claude API ──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// ── 工具函数 ──
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function callClaude(systemPrompt, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

// ── 日期工具 ──
function getTodayString() {
  const now = new Date();
  // 转换为北京时间
  const bjTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bjTime.getFullYear();
  const m = String(bjTime.getMonth() + 1).padStart(2, '0');
  const d = String(bjTime.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatChineseDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const days = ['日','一','二','三','四','五','六'];
  const date = new Date(`${dateStr}T00:00:00+08:00`);
  const weekday = days[date.getDay()];
  return `${y}年${parseInt(m)}月${parseInt(d)}日 · 星期${weekday}`;
}

// ── 获取历史版本列表 ──
function getHistoryLinks(currentDate) {
  if (!existsSync(DOCS_DIR)) return `<a href="./${currentDate}.html" class="current">${currentDate} · 最新</a>`;

  const files = readdirSync(DOCS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map(f => f.replace('.html', ''))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 7);

  if (!files.includes(currentDate)) files.unshift(currentDate);

  return files.map((date, i) => {
    const label = i === 0 ? `${date} · 最新` : date;
    const cls = date === currentDate ? ' class="current"' : '';
    return `<a href="./${date}.html"${cls}>${label}</a>`;
  }).join('\n    ');
}

// ── 读取 HTML 模板 ──
function getTemplate() {
  const templatePath = join(ROOT, 'templates', 'base.html');
  return readFileSync(templatePath, 'utf-8');
}

// ── Step 1: 生成推文摘要 ──
async function summarizeTweets(builders, prompt) {
  console.log(`📝 生成推文摘要，共 ${builders.length} 位 Builder...`);

  const results = [];
  for (const builder of builders) {
    if (!builder.tweets || builder.tweets.length === 0) continue;

    const tweetsText = builder.tweets.map(t =>
      `[${t.createdAt}] ${t.text}\n链接: ${t.url}\n互动: ❤${t.likes} ↻${t.retweets} 💬${t.replies}`
    ).join('\n\n---\n\n');

    const userMsg = `请为以下 Builder 的推文生成中文摘要。

Builder 信息：
- 姓名：${builder.name}
- Handle：@${builder.handle}
- Bio：${builder.bio || '无'}

推文内容：
${tweetsText}`;

    try {
      const summary = await callClaude(prompt, userMsg);
      results.push({
        ...builder,
        summary,
        topTweet: builder.tweets.reduce((a, b) => (a.likes + a.retweets > b.likes + b.retweets) ? a : b)
      });
      process.stdout.write('.');
    } catch (err) {
      console.error(`\n⚠️  ${builder.name} 摘要生成失败: ${err.message}`);
      results.push({ ...builder, summary: '本期无实质更新，建议查看原推。', topTweet: builder.tweets[0] });
    }
  }
  console.log('\n✅ 推文摘要完成');
  return results;
}

// ── Step 2: 生成播客摘要 ──
async function summarizePodcast(podcast, prompt) {
  if (!podcast) return null;
  console.log(`🎙️  生成播客摘要: ${podcast.title}...`);

  const userMsg = `请为以下播客生成中文摘要。

播客信息：
- 节目名：${podcast.name}
- 本期标题：${podcast.title}
- 链接：${podcast.url}

转录内容（节选）：
${(podcast.transcript || '').slice(0, 8000)}`;

  try {
    const summary = await callClaude(prompt, userMsg);
    console.log('✅ 播客摘要完成');
    return { ...podcast, summary };
  } catch (err) {
    console.error(`⚠️  播客摘要失败: ${err.message}`);
    return null;
  }
}

// ── Step 3: 生成编辑决策（头条、速览、金句、按语、标签）──
async function generateEditorial(builders, podcast, blogs) {
  console.log('🗞️  生成编辑决策...');

  const context = builders.slice(0, 10).map(b =>
    `【${b.name}】互动最高推文(❤${b.topTweet?.likes}):\n${b.topTweet?.text}\n摘要: ${b.summary}`
  ).join('\n\n');

  const prompt = `你是 AI Signal 日报的主编，请根据今日内容做以下编辑决策，用 JSON 格式输出。

今日内容概览：
${context}
${podcast ? `\n播客：${podcast.title}\n${podcast.summary}` : ''}

请输出以下 JSON（不要有任何 markdown 代码块，直接输出 JSON）：
{
  "headline": "今日最重要的一句话标题（20字以内，中文）",
  "deck": "头条导语，1-2句话解释为什么重要（50字以内）",
  "speedRead": [
    {"name": "Builder名字", "text": "一句话核心信息（30字以内）"},
    {"name": "Builder名字", "text": "一句话核心信息（30字以内）"},
    {"name": "Builder名字", "text": "一句话核心信息（30字以内）"}
  ],
  "quoteText": "今日最精彩的英文原句（直接引用推文原文）",
  "quoteAttr": "作者名 · @handle on X",
  "editorial": "主编按语，2-3句话串联今天的主题（80字以内）",
  "tags": ["#标签1", "#标签2", "#标签3", "#标签4"]
}`;

  try {
    const raw = await callClaude('你是专业的 AI 行业日报主编，擅长提炼关键信号。', prompt);
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleaned);
    console.log('✅ 编辑决策完成');
    return result;
  } catch (err) {
    console.error('⚠️  编辑决策失败:', err.message);
    return {
      headline: '今日 AI Builder 动态精选',
      deck: '来自 X 和播客的最新信号。',
      speedRead: builders.slice(0, 3).map(b => ({ name: b.name, text: b.summary?.slice(0, 50) || '查看原推' })),
      quoteText: builders[0]?.topTweet?.text?.slice(0, 100) || '',
      quoteAttr: `${builders[0]?.name} · @${builders[0]?.handle} on X`,
      editorial: '今日 Builder 动态已汇总，欢迎查阅。',
      tags: ['#AI产品', '#Builder动态']
    };
  }
}

// ── Step 4: 渲染 Builder 卡片 ──
function renderBuilderCards(builders) {
  const cards = builders.map((b, i) => {
    const isLead = i === 0;
    const tweet = b.topTweet;
    const engageStr = tweet ? `❤ ${tweet.likes} &nbsp;↻ ${tweet.retweets} &nbsp;💬 ${tweet.replies}` : '';

    return `
    <div class="gcol${isLead ? ' span-2' : ''}">
      <div class="art-kicker">AI 动态 · X Signal</div>
      <h2 class="art-hed${isLead ? ' lg' : ''}">${escapeHtml(b.summary?.split('。')[0] || b.name)}</h2>
      <div class="byline">
        ${escapeHtml(b.name)}
        <span class="handle">@${b.handle}</span>
        ${tweet ? `<span class="ts">${tweet.createdAt?.slice(0, 10)}</span>` : ''}
      </div>
      ${tweet ? `
      <div class="tweet-orig">
        ${escapeHtml(tweet.text.slice(0, 200))}${tweet.text.length > 200 ? '…' : ''}
        <a href="${tweet.url}" target="_blank">↗ 查看原推</a>
      </div>` : ''}
      <div class="sumbox lime">
        <div class="lbl">中文摘要</div>
        <p>${escapeHtml(b.summary || '本期无实质更新，建议查看原推。')}</p>
      </div>
      ${engageStr ? `<div class="engage">${engageStr}</div>` : ''}
    </div>`;
  });

  // 每3个一行排列
  const rows = [];
  for (let i = 0; i < cards.length; i += 3) {
    const chunk = cards.slice(i, i + 3);
    const gridClass = i === 0 ? 'grid-3' : 'grid-3-row2';
    rows.push(`<div class="${gridClass}">${chunk.join('')}</div>`);
  }
  return rows.join('\n');
}

// ── Step 5: 渲染播客板块 ──
function renderPodcastSection(podcast) {
  if (!podcast) return '<p style="padding:24px;color:var(--ink3);">今日暂无播客更新。</p>';

  return `
  <div class="sec-bar" id="sec-podcast">
    <span class="sec-tag">播客专题</span>
    <span class="sec-title">深度访谈</span>
  </div>
  <div class="feature-wrap">
    <div class="feature-hero">
      <div class="feat-kicker">播客 · Podcast</div>
      <h2 class="feat-hed">${escapeHtml(podcast.title)}</h2>
      <p class="feat-deck">${escapeHtml(podcast.name)}</p>
    </div>
    <div class="feature-body-grid">
      <div class="feat-main">
        <p class="feat-body drop">${escapeHtml(podcast.summary || '')}</p>
        <div class="feat-meta">
          <a href="${podcast.url}" target="_blank">↗ 查看原视频</a>
        </div>
      </div>
    </div>
  </div>`;
}

// ── Step 6: 渲染国内板块 ──
function renderChinaSection(blogs) {
  const cnBlogs = blogs.filter(b =>
    b.url?.includes('36kr') || b.url?.includes('technode') ||
    b.source?.includes('china') || b.source?.includes('cn')
  );

  if (cnBlogs.length === 0) {
    return `
  <div class="sec-bar">
    <span class="sec-tag orange">中文圈 · China Watch</span>
    <span class="sec-title">国内 AI 前线</span>
  </div>
  <p style="padding:24px;color:var(--ink3);">今日暂无国内 AI 动态。</p>`;
  }

  const cards = cnBlogs.map(b => `
    <div class="gcol">
      <div class="art-kicker">国内动态</div>
      <h3 class="art-hed sm">${escapeHtml(b.title || '')}</h3>
      <div class="byline">${escapeHtml(b.name || b.source || '')}</div>
      <div class="art-body">${escapeHtml((b.description || b.content || '').slice(0, 200))}…</div>
      <div style="margin-top:8px;">
        <a href="${b.url}" target="_blank" style="font-size:10px;font-weight:900;color:var(--orange);text-decoration:none;letter-spacing:0.06em;text-transform:uppercase;">↗ 查看原文</a>
      </div>
    </div>`).join('');

  return `
  <div class="sec-bar">
    <span class="sec-tag orange">中文圈 · China Watch</span>
    <span class="sec-title">国内 AI 前线</span>
    <span class="sec-count">公开来源 · 每日更新</span>
  </div>
  <div class="grid-3">${cards}</div>`;
}

// ── HTML 转义 ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 渲染速览条目 ──
function renderSpeedRead(items) {
  return items.map((item, i) => `
    <div class="sp-item">
      <div class="sp-n">${i + 1}</div>
      <div class="sp-t"><strong>${escapeHtml(item.name)}：</strong>${escapeHtml(item.text)}</div>
    </div>`).join('');
}

// ── 渲染标签 ──
function renderTags(tags) {
  return tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('\n        ');
}

// ── 获取期号 ──
function getVolNum() {
  const statePath = join(ROOT, 'state.json');
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      return state.vol || 1;
    } catch { return 1; }
  }
  return 1;
}

function incrementVolNum(vol) {
  const statePath = join(ROOT, 'state.json');
  writeFileSync(statePath, JSON.stringify({ vol: vol + 1 }, null, 2));
}

// ── 主流程 ──
async function main() {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('缺少 ANTHROPIC_API_KEY 环境变量');
  }

  console.log('🚀 AI Signal 日报生成开始...\n');

  // 1. 拉取数据
  console.log('📡 拉取数据源...');
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL).catch(() => ({ blogs: [] }))
  ]);
  console.log(`✅ 数据拉取完成: ${feedX.x?.length} 位 Builder, ${feedPodcasts.podcasts?.length} 个播客`);

  // 2. 拉取 prompts
  console.log('📋 拉取 Prompts...');
  const [tweetPrompt, podcastPrompt] = await Promise.all([
    fetchText(`${PROMPTS_BASE}/summarize-tweets.md`),
    fetchText(`${PROMPTS_BASE}/summarize-podcast.md`)
  ]);

  // 使用本地自定义 prompt（如果存在）
  const localTweetPrompt = existsSync(join(ROOT, 'prompts', 'summarize-tweets.md'))
    ? readFileSync(join(ROOT, 'prompts', 'summarize-tweets.md'), 'utf-8')
    : tweetPrompt;

  // 3. 生成摘要
  const builders = await summarizeTweets(feedX.x || [], localTweetPrompt);
  const podcast  = await summarizePodcast(feedPodcasts.podcasts?.[0], podcastPrompt);

  // 4. 编辑决策
  const editorial = await generateEditorial(builders, podcast, feedBlogs.blogs || []);

  // 5. 渲染 HTML
  console.log('🎨 渲染 HTML...');
  const today   = getTodayString();
  const vol     = getVolNum();
  const history = getHistoryLinks(today);
  const template = getTemplate();

  const hasPodcast = !!podcast;

  const navItems = [
    `<a href="#" data-tab="china" class="active">国内 AI 前线</a>`,
    `<a href="#" data-tab="global">海外 Builder 动态</a>`,
    hasPodcast ? `<a href="#" data-tab="podcast">播客专题</a>` : ''
  ].filter(Boolean).join('\n    ');

  const html = template
    .replace('{{DATE_SHORT}}', today)
    .replace('{{DATE}}', formatChineseDate(today))
    .replace(/\{\{VOL_NUM\}\}/g, String(vol).padStart(3, '0'))
    .replace('{{BUILDER_COUNT}}', builders.length)
    .replace('{{TWEET_COUNT}}', feedX.stats?.totalTweets || 0)
    .replace('{{PODCAST_COUNT}}', hasPodcast ? '1' : '0')
    .replace('{{HISTORY_LINKS}}', history)
    .replace('{{NAV_ITEMS}}', navItems)
    .replace('{{LEAD_HEADLINE}}', escapeHtml(editorial.headline))
    .replace('{{LEAD_DECK}}', escapeHtml(editorial.deck))
    .replace('{{SPEED_READ_ITEMS}}', renderSpeedRead(editorial.speedRead))
    .replace('{{QUOTE_TEXT}}', escapeHtml(editorial.quoteText))
    .replace('{{QUOTE_ATTR}}', escapeHtml(editorial.quoteAttr))
    .replace('{{EDITORIAL_TEXT}}', escapeHtml(editorial.editorial))
    .replace('{{TAG_ITEMS}}', renderTags(editorial.tags))
    .replace('{{CHINA_SECTION}}', renderChinaSection(feedBlogs.blogs || []))
    .replace('{{BUILDER_CARDS}}', renderBuilderCards(builders))
    .replace('{{PODCAST_SECTION}}', renderPodcastSection(podcast));

  // 6. 写入文件
  mkdirSync(DOCS_DIR, { recursive: true });
  const outputPath = join(DOCS_DIR, `${today}.html`);
  const indexPath  = join(DOCS_DIR, 'index.html');

  writeFileSync(outputPath, html, 'utf-8');
  writeFileSync(indexPath, html, 'utf-8');
  incrementVolNum(vol);

  console.log(`\n✅ 日报生成完成！`);
  console.log(`📄 文件: docs/${today}.html`);
  console.log(`🔢 期号: Vol. I No.${String(vol).padStart(3, '0')}`);
}

main().catch(err => {
  console.error('❌ 生成失败:', err.message);
  process.exit(1);
});
