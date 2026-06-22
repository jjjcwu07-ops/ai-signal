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

// ── DeepSeek API ──
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = 'deepseek-reasoner';

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
  const baseSystem = `你是一位有15年经验的资深管理咨询顾问，同时也是AI行业的深度观察者。
写作风格要求：直接、具体、有判断力。
严禁使用的词汇：值得关注、意义重大、带来机遇、面临挑战、不可忽视、深刻影响、赋能、加速、布局。
每一句话都必须能回答"所以呢？对我有什么用？"这个问题。`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [
        // deepseek-reasoner 不支持 system 角色，合并进第一条 user 消息
        { role: 'user', content: `${baseSystem}\n\n${systemPrompt}\n\n${userMessage}` }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
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
  let files = [];

  if (existsSync(DOCS_DIR)) {
    files = readdirSync(DOCS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
      .map(f => f.replace('.html', ''))
      .sort((a, b) => b.localeCompare(a)); // 倒序：最新在前
  }

  // 确保今日日期在列表里
  if (!files.includes(currentDate)) files.unshift(currentDate);

  // 最多显示 7 条，今日永远第一
  const display = files.slice(0, 7);

  return display.map((date) => {
    const isToday = date === currentDate;
    const label = isToday ? `${date} · 最新` : date;
    const cls = isToday ? ' class="current"' : '';
    // 今日用 index.html（保证始终可达），历史用具体日期文件
    const href = isToday ? './index.html' : `./${date}.html`;
    return `<a href="${href}"${cls}>${label}</a>`;
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

    const userMsg = `请为以下 Builder 的推文生成两部分内容，直接输出 JSON（不要 markdown 代码块）：
{
  "summary": "中文摘要，3-5句话，自然流畅，像人写的，不是机器翻译，专有名词保留英文",
  "consulting": "你是顶级咨询公司Managing Partner，主导过多个大型AI战略项目。看完这条动态，从咨询公司自身AI转型、顾问能力结构重塑、客户项目方法论迭代、行业竞争格局这四个维度判断是否有值得说的洞见。没有实质启示就返回空字符串。有的话写1-2句话：站在行业和公司经营层面，直接给判断，不能说大家都知道的话，语言专业克制，不口语化。禁止词：值得关注/带来机遇/面临挑战/赋能/加速/布局/深刻/颠覆"
}

Builder 信息：
- 姓名：${builder.name}
- Handle：@${builder.handle}
- Bio：${builder.bio || '无'}

推文内容：
${tweetsText}

注意：如果内容实在太空洞，summary 写"本期无实质更新"，consulting 写空字符串。`;

    try {
      const raw = await callClaude(prompt, userMsg);
      // R1 会输出思考链，提取 JSON 对象部分
      const match = raw.match(/\{[\s\S]*\}/);
      const cleaned = match ? match[0] : raw;
      let parsed = { summary: raw, consulting: '' };
      try { parsed = JSON.parse(cleaned); } catch(e) { parsed.summary = raw; }
      results.push({
        ...builder,
        summary: parsed.summary || '',
        consulting: parsed.consulting || '',
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

  const userMsg = `请为以下播客生成两部分内容：

第一部分：把播客标题翻译成精炼的中文（10-20字，让读者一眼读懂核心话题，不要直译，要意译）。
第二部分：用流畅自然的中文段落写播客摘要，要求：
- 不要用编号列表（不要出现"1." "2."格式）
- 分3-4个自然段，每段聚焦一个核心话题
- 语言像专业媒体的深度报道，不是逐字翻译
- 保留重要的英文专有名词

请按以下格式输出（不要有任何其他内容）：
中文标题：[翻译后的标题]
摘要：[正文内容]

播客信息：
- 节目名：${podcast.name}
- 本期标题：${podcast.title}
- 链接：${podcast.url}

转录内容（节选）：
${(podcast.transcript || '').slice(0, 8000)}`;

  try {
    const raw = await callClaude('你是专业的播客内容编辑，擅长把英文播客提炼成深度中文报道。', userMsg);
    // 解析标题和摘要
    const titleMatch = raw.match(/中文标题：(.+)/);
    const summaryMatch = raw.match(/摘要：([\s\S]+)/);
    const chineseTitle = titleMatch ? titleMatch[1].trim() : podcast.title;
    const summary = summaryMatch ? summaryMatch[1].trim() : raw;
    console.log('✅ 播客摘要完成');
    return { ...podcast, summary, chineseTitle };
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
  "deck": "头条导语，1-2句话解释为什么重要（50字以内，中文）",
  "speedRead": [
    {"name": "Builder名字", "text": "一句话核心信息（30字以内，中文）"},
    {"name": "Builder名字", "text": "一句话核心信息（30字以内，中文）"},
    {"name": "Builder名字", "text": "一句话核心信息（30字以内，中文）"}
  ],
  "quoteText": "今日最值得记住的一句话。翻译要求：1)必须是中文；2)地道自然，像中国人说的话，绝不逐字直译；3)长度不限，但要精炼；4)最重要：要有洞见、能引发思考，让人读完想停下来回味一下",
  "quoteAttr": "作者中文名 · @handle",
  "editorial": "主编按语，2-3句话串联今天的主题（80字以内，中文）",
  "tags": ["#标签1", "#标签2", "#标签3", "#标签4"]
}`;

  try {
    const raw = await callClaude(
      '你是专业的 AI 行业日报主编，擅长提炼关键信号。特别注意：金句翻译要像中国人说的话，简洁有力，绝不机器直译。',
      prompt
    );
    // R1 会输出思考链，提取 JSON 对象部分
    const match = raw.match(/\{[\s\S]*\}/);
    const cleaned = match ? match[0] : raw.replace(/```json\n?|\n?```/g, '').trim();
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
  const rows = [];
  for (let i = 0; i < builders.length; i += 3) {
    const chunk = builders.slice(i, i + 3);
    const cards = chunk.map(b => {
      const tweet = b.topTweet;
      const engageStr = tweet ? `❤ ${tweet.likes} &nbsp;↻ ${tweet.retweets} &nbsp;💬 ${tweet.replies}` : '';
      return `
    <div class="gcol">
      <div class="art-kicker">AI 动态 · X Signal</div>
      <h2 class="art-hed sm">${mdToHtml(escapeHtml(b.summary?.split('。')[0] || b.name))}</h2>
      <div class="byline">
        ${escapeHtml(b.name)}
        <span class="handle">@${b.handle}</span>
        ${tweet ? `<span class="ts">${tweet.createdAt?.slice(0, 10)}</span>` : ''}
      </div>
      ${tweet ? `
      <div class="tweet-orig">
        ${escapeHtml(tweet.text.slice(0, 180))}${tweet.text.length > 180 ? '…' : ''}
        <a href="${tweet.url}" target="_blank">↗ 查看原推</a>
      </div>` : ''}
      <div class="sumbox lime">
        <div class="lbl">中文摘要</div>
        <p>${mdToHtml(escapeHtml(b.summary || ''))}</p>
      </div>
      ${b.consulting ? `
      <div class="sumbox" style="border-left:3px solid var(--orange);background:var(--white);margin-top:8px;">
        <div class="lbl" style="color:var(--orange);">🧭 顾问有话说</div>
        <p>${mdToHtml(escapeHtml(b.consulting))}</p>
      </div>` : ''}
      ${engageStr ? `<div class="engage">${engageStr}</div>` : ''}
    </div>`;
    }).join('');
    rows.push(`<div class="${i === 0 ? 'grid-3' : 'grid-3-row2'}">${cards}</div>`);
  }
  return rows.join('\n');
}

// ── Step 5: 渲染播客板块 ──
function renderPodcastSection(podcast) {
  if (!podcast) return '<p style="padding:24px;color:var(--ink3);">今日暂无播客更新。</p>';

  const rawSummary = podcast.summary || '';
  // 完整保留内容，不截断
  const safeRaw = rawSummary.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const summaryHtml = `<p class="feat-body drop">${mdToHtml(safeRaw)}</p>`;

  // 右侧要点：优先提取 ## 标题，没有则按句号切取前4句有意义的句子
  const headings = [...rawSummary.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim());
  let keyItems;
  if (headings.length >= 2) {
    keyItems = headings.slice(0, 4);
  } else {
    // 按句号、问号、感叹号切句子，过滤掉太短的
    keyItems = rawSummary
      .replace(/#{1,3}\s+/g, '') // 去掉标题符号
      .split(/(?<=[。！？])\s*/)
      .map(s => s.trim())
      .filter(s => s.length > 20)
      .slice(0, 4);
  }
  const keyPoints = keyItems.map((s, i) => `
      <div class="kp">
        <div class="kp-n">${i + 1}</div>
        <div class="kp-t">${mdToHtml(s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))}</div>
      </div>`).join('');

  return `
  <div class="feature-wrap">
    <div class="feature-hero">
      <div class="feat-kicker">播客 · Podcast</div>
      <h2 class="feat-hed">${escapeHtml(podcast.chineseTitle || podcast.title)}</h2>
      <p class="feat-deck" style="margin-bottom:4px;">${escapeHtml(podcast.name)}</p>
      ${podcast.chineseTitle ? `<p style="font-size:11px;color:var(--ink4);font-style:italic;">${escapeHtml(podcast.title)}</p>` : ''}
    </div>
    <div class="feature-body-grid">
      <div class="feat-main">
        ${summaryHtml}
        <div class="feat-meta">
          <a href="${podcast.url}" target="_blank">↗ 查看原视频</a>
        </div>
      </div>
      <div class="feat-sidebar">
        <div class="kp-header">核心要点</div>
        ${keyPoints}
      </div>
    </div>
  </div>`;
}

// ── Step 0: 用 DeepSeek 搜索今日国内 AI 新闻 ──
async function fetchChinaNews(today) {
  console.log('🔍 搜索今日国内 AI 新闻...');

  // 第一步：获取新闻基本信息（简单 JSON，不容易出错）
  const newsPrompt = `今天是 ${today}，请整理今日（或最近2天内）国内 AI 领域最重要的4条新闻。
重点关注：国内大模型进展、AI产品发布、融资并购、政策监管、百度/阿里/字节/腾讯/华为/DeepSeek/智谱/月之暗面等公司动态。
直接输出JSON数组，不要有任何其他文字：
[{"title":"标题(20字内)","source":"来源媒体","summary":"两句话说清楚发生了什么和为什么重要(80字内)","term":"只解释咨询顾问可能不熟悉的AI技术词汇（如模型架构、训练方法、技术参数等），格式：名词：解释(30字内)。如果新闻里没有需要解释的技术词汇，返回空字符串"}]`;

  let news = [];
  try {
    const raw = await callDeepSeekSearch(newsPrompt);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error('未找到 JSON 数组');
    news = JSON.parse(match[0]);
    console.log(`✅ 国内新闻获取完成，共 ${news.length} 条`);
  } catch (err) {
    console.error('⚠️  国内新闻获取失败:', err.message);
    return [];
  }

  // 第二步：单独为每条新闻生成顾问洞见
  for (const item of news) {
    try {
      const consultingPrompt = `新闻：${item.title}。${item.summary}

你是顶级咨询公司的Managing Partner，主导过多个大型AI战略项目。从以下维度判断这条新闻是否有值得说的洞见：咨询公司自身AI转型和组织变革、顾问能力结构重塑、客户AI战略项目的方法论迭代、行业竞争格局对咨询业务模式的影响。

如果没有实质性启示，直接回复：无

有的话写1-2句话。要求：站在行业和公司经营层面；直接给判断不铺垫；不能说大家都知道的话；语言专业克制不口语化；不要用JSON格式。禁止词：值得关注/带来机遇/面临挑战/赋能/加速/布局/深刻/颠覆。`;
      let result = await callDeepSeekSearch(consultingPrompt);
      // 清洗掉可能的 JSON 包装
      result = result.trim();
      try {
        const parsed = JSON.parse(result);
        // 如果是 JSON，提取里面的字符串值
        const val = Object.values(parsed)[0];
        result = typeof val === 'string' ? val : '';
      } catch(e) {
        // 不是 JSON，直接用
      }
      // 过滤掉"无"或空，以及开头多余的"有。""有："等
      result = result.replace(/^有[。：:]\s*/,'').trim();
      item.consulting = (result === '无' || result === '' || result.length < 5) ? '' : result;
    } catch (e) {
      item.consulting = '';
    }
  }

  return news;
}

// ── DeepSeek 联网搜索版本 ──
async function callDeepSeekSearch(userMessage) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `你是专业的AI行业资讯编辑，熟悉国内外AI动态。请基于你的知识库，提供准确的近期资讯。直接输出JSON，不要有任何多余文字。\n\n${userMessage}`
        }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── Step 6: 渲染国内 AI 新闻板块 ──
async function renderChinaSection(blogs, today) {
  const news = await fetchChinaNews(today);

  if (news.length === 0) {
    return `
  <div class="sec-bar">
    <span class="sec-tag">中文圈</span>
    <span class="sec-title">国内 AI 前线</span>
  </div>
  <p style="padding:24px;color:var(--ink3);">今日暂无国内 AI 动态。</p>`;
  }

  const rows = [];
  for (let i = 0; i < news.length; i += 2) {
    const chunk = news.slice(i, i + 2).map(item => {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent((item.title || '') + ' ' + (item.source || ''))}`;
      const linkUrl = item.url || searchUrl;
      return `
    <div class="gcol">
      <div class="art-kicker">${escapeHtml(item.source || '国内动态')}</div>
      <h3 class="art-hed">${escapeHtml(item.title || '')}</h3>
      <div class="art-body" style="margin:10px 0;">${escapeHtml(item.summary || '')}</div>
      ${item.term ? `
      <div class="sumbox lime" style="margin:8px 0;">
        <div class="lbl">名词解释</div>
        <p>${escapeHtml(item.term)}</p>
      </div>` : ''}
      ${item.consulting ? `
      <div class="sumbox" style="border-left:3px solid var(--orange);background:var(--white);margin:8px 0;">
        <div class="lbl" style="color:var(--orange);">🧭 顾问有话说</div>
        <p>${escapeHtml(item.consulting)}</p>
      </div>` : ''}
      <div style="margin-top:10px;font-size:11px;font-weight:900;letter-spacing:0.06em;">
        来源：<a href="${linkUrl}" target="_blank" style="color:var(--orange);text-decoration:underline;">${escapeHtml(item.source || '查看原文')} ↗</a>
      </div>
    </div>`;
    }).join('');

    const count = news.slice(i, i + 2).length;
    const gridStyle = count < 3
      ? `display:grid;grid-template-columns:${count === 1 ? '1fr' : '1fr 1fr'};gap:0;border:2px solid var(--black);background:var(--black);`
      : '';
    const gridClass = i === 0 ? 'grid-3' : 'grid-3-row2';
    rows.push(`<div class="${gridClass}"${gridStyle ? ` style="${gridStyle}"` : ''}>${chunk}</div>`);
  }

  return `
  <div class="sec-bar">
    <span class="sec-tag">中文圈</span>
    <span class="sec-title">国内 AI 前线</span>
    <span class="sec-count">公开来源 · 每日更新</span>
  </div>
  ${rows.join('\n')}`;
}

// ── Markdown 转 HTML ──
function mdToHtml(str) {
  if (!str) return '';
  return str
    .replace(/^### (.+)$/gm, '<h4 style="font-size:14px;font-weight:900;margin:12px 0 6px;">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="font-size:16px;font-weight:900;margin:16px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="font-size:18px;font-weight:900;margin:16px 0 8px;">$1</h2>')
    .replace(/^\d+\. (.+)$/gm, '<li style="margin:4px 0 4px 16px;list-style:decimal;">$1</li>')
    .replace(/^[-*] (.+)$/gm, '<li style="margin:4px 0 4px 16px;list-style:disc;">$1</li>')
    // 把连续的 li 包进同一个 ol/ul，而不是每个都单独包
    .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, (match) => {
      return `<ol style="padding-left:8px;margin:8px 0;">${match}</ol>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n\n+/g, '</p><p style="margin:10px 0;">')
    .replace(/\n/g, '<br>');
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
  if (!DEEPSEEK_API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量');
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

  // 3. 生成摘要，过滤掉无实质内容的 Builder
  const allBuilders = await summarizeTweets(feedX.x || [], localTweetPrompt);
  const builders = allBuilders.filter(b =>
    b.summary && !b.summary.includes('本期无实质更新')
  );
  console.log(`✅ 有效 Builder：${builders.length} 位（过滤掉 ${allBuilders.length - builders.length} 位无实质内容）`);
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
    .replace(/\{\{DATE_SHORT\}\}/g, today)
    .replace(/\{\{DATE\}\}/g, formatChineseDate(today))
    .replace(/\{\{VOL_NUM\}\}/g, String(vol).padStart(3, '0'))
    .replace(/\{\{BUILDER_COUNT\}\}/g, builders.length)
    .replace(/\{\{TWEET_COUNT\}\}/g, feedX.stats?.totalTweets || 0)
    .replace(/\{\{PODCAST_COUNT\}\}/g, hasPodcast ? '1' : '0')
    .replace('{{HISTORY_LINKS}}', history)
    .replace('{{NAV_ITEMS}}', navItems)
    .replace('{{LEAD_HEADLINE}}', escapeHtml(editorial.headline))
    .replace('{{LEAD_DECK}}', escapeHtml(editorial.deck))
    .replace('{{SPEED_READ_ITEMS}}', renderSpeedRead(editorial.speedRead))
    .replace('{{QUOTE_TEXT}}', escapeHtml(editorial.quoteText))
    .replace('{{QUOTE_ATTR}}', escapeHtml(editorial.quoteAttr))
    .replace('{{EDITORIAL_TEXT}}', escapeHtml(editorial.editorial))
    .replace('{{TAG_ITEMS}}', renderTags(editorial.tags))
    .replace('{{CHINA_SECTION}}', await renderChinaSection(feedBlogs.blogs || [], today))
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
