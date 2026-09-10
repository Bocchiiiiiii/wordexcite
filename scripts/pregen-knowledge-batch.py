#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pregen-knowledge-batch.py — SiliconFlow Batch API 批量预生成词汇知识卡

把 words/cet6.json（5407 词）的知识卡批量生成，合并写回树莓派服务器
键 cet6knowledge.v1（cet6）。前端零改动：initStorage 下次访问自动拉取。

用法：
  python scripts/pregen-knowledge-batch.py --fetch                 # 经 tunnel 拉取服务器当前缓存 + 用户 AI 配置
  python scripts/pregen-knowledge-batch.py --gen [--skip-existing] # 生成 jsonl 分批文件（每批 ≤5000 行）
  python scripts/pregen-knowledge-batch.py --sub <jsonl>           # 上传文件、创建 batch
  python scripts/pregen-knowledge-batch.py --poll --id <batch_id> [--wait]
  python scripts/pregen-knowledge-batch.py --apply --id <batch_id> [--push] [--all]

API Key 优先级：--key 参数 > 环境变量 SILICONFLOW_API_KEY > --fetch 拉的服务器用户 aiApiKey。

写回（--push）走 SSH 直写 sqlite：与 server.py kv_set + kv_history 备份逻辑一致，
避开 HTTP PUT 8MB 上限；写回前已在 --fetch 阶段本地留档服务器当前缓存。
"""
import argparse
import copy
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

try:
    import paramiko
    import requests
except ImportError:
    print("需要 paramiko 与 requests：pip install paramiko requests", file=sys.stderr)
    sys.exit(1)

# ---------------- 常量 ----------------
API_BASE = "https://api.siliconflow.cn/v1"
MODEL = "deepseek-ai/DeepSeek-V4-Flash"
MAX_ROWS_PER_FILE = 5000       # 官方单文件上限 5000 行 / 1GB
COMPLETION_WINDOW = "24h"
TEMPERATURE = 0.2
MAX_TOKENS = 1600

KEY_STUDY = "cet6study.v1"          # cet6
KEY_KNOWLEDGE = "cet6knowledge.v1"  # cet6

TUNNEL_HOSTNAME = "example.com"
TUNNEL_PORT = 12230
SSH_USER = "pi"
SSH_PASS = "123"
PI_STATE_URL = "http://127.0.0.1:8001/api/state"
PI_DB = "/var/lib/study-api/state.db"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORD_FILE = os.path.join(ROOT, "words", "cet6.json")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "batch")

WORDS_MAP = "cet6-words.json"
SERVER_CACHE = "server-cache.json"
SERVER_STUDY = "server-study.json"
MERGED = "merged-cache.json"


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ---------------- 词库 / 分批 ----------------
def load_words():
    with open(WORD_FILE, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise SystemExit("cet6.json 结构异常：应为 list")
    return data


def write_words_map(words):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, WORDS_MAP), "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False)
    print(f"words map: {OUT_DIR}/{WORDS_MAP} ({len(words)} 词)")


def load_words_map():
    p = os.path.join(OUT_DIR, WORDS_MAP)
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def is_cached_valid(entry):
    """与前端 isCached 一致：v==2 或 v==3 且存在 etymology 字段。"""
    return bool(entry and isinstance(entry, dict) and
                entry.get("v") in (2, 3) and entry.get("etymology"))


# 前端 script.js fetchKnowledge 的 prompt 全文（原样移植）
def make_prompt(w):
    return (
        "你是六级英语词汇助教。\n"
        "请为单词\"" + w["en"] + "\"（音标：" + (w.get("phonetic") or "无") +
        "；词库释义：" + w["zh"] + "）生成六级学习内容，要求：\n"
        "1. 中文释义：只列出该单词真实的常用词性及对应中文释义，每个释义一项，词性用 \"n.\" \"v.\" \"vt.\" \"vi.\" "
        "\"adj.\" \"adv.\" \"prep.\" 等常见缩写，不要臆造词性或释义；\n"
        "2. 例句：为上面每一个释义各配一个六级难度的英文例句和中文翻译，分别放在对应 meanings 项的 "
        "exampleEn 和 exampleZh 字段里；\n"
        "3. 单词变形：列出该单词真实常见的变形词（名词、动词、形容词、副词等），每项包含 word（变形）、"
        "pos（词性）、zh（中文释义）；确实没有变形时返回空数组；\n"
        "4. 短语组合：2-3 个该单词真实常见短语及其中文释义。\n"
        "5. 词根词缀：分析该单词的词根词缀构成。包括：root（核心词根及其含义，如 \"spect = 看\"）、"
        "origin（词源简述，如 \"来自拉丁语 spectare\"；英语本族词可写\"古英语\"）、prefix（前缀及含义，"
        "无前缀时留空）、suffix（后缀及含义，无后缀时留空）、tip（基于词根词缀的联想记忆口诀，一句话）、"
        "related（2-4 个同根词）。\n"
        "如果单词较短或词源不明（如 go, run, good 等基础词汇），origin 可写\"基础词汇，无明显词根词缀\"，"
        "其余字段留空数组。\n\n"
        "只返回JSON，结构如下：\n"
        "{\n"
        "  \"meanings\": [\n"
        "    {\"pos\": \"词性缩写\", \"zh\": \"对应释义\", \"exampleEn\": \"例句\", \"exampleZh\": \"例句翻译\"}\n"
        "  ],\n"
        "  \"variants\": [\n"
        "    {\"word\": \"变形词\", \"pos\": \"词性缩写\", \"zh\": \"对应释义\"}\n"
        "  ],\n"
        "  \"phrases\": [\n"
        "    {\"en\": \"词组\", \"zh\": \"对应释义\"}\n"
        "  ],\n"
        "  \"etymology\": {\n"
        "    \"root\": \"词根及含义\",\n"
        "    \"origin\": \"词源简述\",\n"
        "    \"prefix\": \"前缀及含义\",\n"
        "    \"suffix\": \"后缀及含义\",\n"
        "    \"tip\": \"记忆口诀\",\n"
        "    \"related\": [{\"word\": \"同根词1\", \"pos\": \"词性\", \"zh\": \"释义\"}, ...]\n"
        "  }\n"
        "}\n"
        "只返回JSON，不要输出其他文字。"
    )


def build_batch_rows(words):
    """每行 = OpenAI Batch 输入格式。custom_id = w<index>。"""
    rows = []
    for i, w in enumerate(words):
        rows.append({
            "custom_id": f"w{i:05d}",
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": MODEL,
                "messages": [{"role": "user", "content": make_prompt(w)}],
                "temperature": TEMPERATURE,
                "max_tokens": MAX_TOKENS,
                "response_format": {"type": "json_object"},
            },
        })
    return rows


def cmd_gen(args):
    words = load_words()
    if not words:
        raise SystemExit("cet6.json 为空")
    if args.skip_existing and os.path.exists(os.path.join(OUT_DIR, SERVER_CACHE)):
        with open(os.path.join(OUT_DIR, SERVER_CACHE), "r", encoding="utf-8") as f:
            cache = json.load(f)
        before = len(words)
        words = [w for w in words
                 if not is_cached_valid(cache.get(w["en"].lower()))]
        print(f"--skip-existing: {before} -> {len(words)}（{before - len(words)} 词已缓存有效，跳过）")
    write_words_map(words)
    rows = build_batch_rows(words)
    n = max(1, MAX_ROWS_PER_FILE)
    files = []
    for part, i in enumerate(range(0, len(rows), n), start=1):
        chunk = rows[i:i + n]
        p = os.path.join(OUT_DIR, f"cet6-batch-{part}.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for row in chunk:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        files.append(p)
        print(f"写入 {p}：{len(chunk)} 行")
    print(f"共 {len(rows)} 词 / {len(files)} 批（每批 ≤{MAX_ROWS_PER_FILE}）")


# ---------------- API Key ----------------
def resolve_key(args):
    if args.key:
        return args.key
    env = os.environ.get("SILICONFLOW_API_KEY")
    if env:
        return env.strip()
    p = os.path.join(OUT_DIR, SERVER_STUDY)
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            study = json.load(f)
        if isinstance(study, dict) and study.get("apiKey"):
            return study["apiKey"].strip()
    raise SystemExit("缺少 API Key：用 --key 或环境变量 SILICONFLOW_API_KEY，或先跑 --fetch")


def sf_headers(key):
    return {"Authorization": "Bearer " + key}


def _unwrap(resp):
    """SiliconFlow 外层是 {"code":20000,"data":...}，解包为 data；直接顶层结构则原样返回。"""
    if isinstance(resp, dict) and "data" in resp and resp.get("code") is not None:
        return resp["data"]
    return resp


def sf_get(path, key, params=None):
    r = requests.get(API_BASE + path, headers=sf_headers(key), params=params, timeout=60)
    if r.status_code != 200:
        raise SystemExit(f"GET {path} 失败 {r.status_code}: {r.text[:300]}")
    return _unwrap(r.json())


def sf_get_text(path, key, params=None):
    """返回原始文本（下载 batch 结果文件用）。"""
    r = requests.get(API_BASE + path, headers=sf_headers(key), params=params, timeout=120)
    if r.status_code != 200:
        raise SystemExit(f"GET {path} 失败 {r.status_code}: {r.text[:300]}")
    return r.text


def sf_download_text(ref, key):
    """结果文件可用两种来源：相对 id（/files/{id}/content，带鉴权）或绝对 OSS 签名 URL（免鉴权）。
    ref 以 http 开头则直接 GET，否则走带鉴权接口。"""
    url = ref
    headers = None
    if not (ref.startswith("http://") or ref.startswith("https://")):
        url = API_BASE + "/files/" + ref + "/content"
        headers = sf_headers(key)
    r = requests.get(url, headers=headers, timeout=120)
    if r.status_code != 200:
        raise SystemExit(f"下载结果失败 {ref} -> {r.status_code}: {r.text[:300]}")
    return r.text


def sf_post(path, key, data=None, files=None, json=None):
    r = requests.post(API_BASE + path, headers=sf_headers(key),
                      data=data, files=files, json=json, timeout=120)
    if r.status_code // 100 != 2:
        raise SystemExit(f"POST {path} 失败 {r.status_code}: {r.text[:400]}")
    return _unwrap(r.json())


def sf_extract_id(resp):
    """SiliconFlow 把 id 放在 data.id（外层包装 {"code","data","status"}），也可能直接顶层。
    兼容两种：data 是 dict → data.id（或 data.file_id）；data 是 list → data[0].id。"""
    if not isinstance(resp, dict):
        return ""
    for p in ("id", "file_id", "batch_id"):
        if resp.get(p):
            return str(resp.get(p))
    d = resp.get("data")
    if isinstance(d, dict):
        for p in ("id", "file_id", "batch_id"):
            if d.get(p):
                return str(d.get(p))
    if isinstance(d, list) and d:
        for p in ("id", "file_id", "batch_id"):
            if isinstance(d[0], dict) and d[0].get(p):
                return str(d[0].get(p))
    return ""


# ---------------- 提交 / 轮询 ----------------
def cmd_sub(args):
    key = resolve_key(args)
    jsonl = args.sub
    if not os.path.exists(jsonl):
        raise SystemExit(f"jsonl 不存在：{jsonl}")

    # 上传文件
    with open(jsonl, "rb") as f:
        up = sf_post("/files", key,
                     data={"purpose": "batch"},
                     files={"file": (os.path.basename(jsonl), f, "application/json")})
    file_id = sf_extract_id(up)
    if not file_id:
        raise SystemExit("上传文件响应里没找到 file id：" + json.dumps(up, ensure_ascii=False)[:300])
    print(f"文件已上传：{file_id}")

    # 创建 batch
    created = sf_post("/batches", key, json={
        "input_file_id": file_id,
        "endpoint": "/v1/chat/completions",
        "completion_window": COMPLETION_WINDOW,
        "extra_body": {"replace": {"model": MODEL}},
    })
    batch_id = (created.get("id") or "").strip()
    if not batch_id:
        raise SystemExit("创建 batch 响应里没找到 id：" + json.dumps(created, ensure_ascii=False)[:300])
    print(f"batch 已创建：{batch_id}  status={created.get('status')}")

    # 落盘状态
    base = os.path.splitext(os.path.basename(jsonl))[0]
    state = {
        "batch_id": batch_id,
        "file_id": file_id,
        "jsonl": jsonl,
        "model": MODEL,
        "created_at": now_iso(),
    }
    sp = os.path.join(OUT_DIR, f"batch-{base}.json")
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    print(f"状态已存：{sp}")


def load_states():
    states = []
    for name in sorted(os.listdir(OUT_DIR)):
        if name.startswith("batch-") and name.endswith(".json"):
            p = os.path.join(OUT_DIR, name)
            with open(p, "r", encoding="utf-8") as f:
                states.append(json.load(f))
    return states


def cmd_poll(args):
    key = resolve_key(args)
    if args.id:
        states = [{"batch_id": args.id}]
    else:
        states = load_states()
        if not states:
            raise SystemExit("没找到 batch 状态文件；先用 --sub，或用 --id 指定")
    done_status = {"completed", "failed", "expired", "cancelled"}
    while True:
        all_done = True
        for st in states:
            info = sf_get("/batches/" + st["batch_id"], key)
            status = info.get("status", "?")
            rc = (info.get("request_counts") or {})
            line = (f"{st['batch_id']} status={status} "
                    f"total={rc.get('total')} completed={rc.get('completed')} "
                    f"failed={rc.get('failed')} output_file={info.get('output_file_id') or '-'}")
            print(line, flush=True)
            if status not in done_status:
                all_done = False
        if all_done or not args.wait:
            break
        time.sleep(args.wait)


# ---------------- 归一化（与前端 normalizeKnowledge 一致） ----------------
def extract_json(text):
    t = re.sub(r"```json", "", text or "", flags=re.I)
    t = re.sub(r"```", "", t).strip()
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("AI 返回内容不是 JSON")
    s = t[start:end + 1]
    try:
        return json.loads(s)
    except Exception:
        fixed = re.sub(r",\s*([}\]])", r"\1", s)
        fixed = re.sub(r"(\")\s*\r?\n(\s*\")", r"\1,\n\2", fixed)
        fixed = re.sub(r"([}\]0-9])\s*\r?\n(\s*\")", r"\1,\n\2", fixed)
        try:
            return json.loads(fixed)
        except Exception as e:
            raise ValueError("AI 返回内容不是合法 JSON：" + str(e))


def normalize(w, raw):
    """返回与前端 normalizeKnowledge 相同的 v3 结构。"""
    obj = raw if isinstance(raw, dict) else {}
    meanings = []
    for m in (obj.get("meanings") or []):
        if not isinstance(m, dict):
            meanings.append({"pos": "", "zh": str(m or ""), "exampleEn": "", "exampleZh": ""})
            continue
        ex = m.get("example") if isinstance(m.get("example"), dict) else {}
        meanings.append({
            "pos": str(m.get("pos") or "").strip(),
            "zh": str(m.get("zh") or "").strip(),
            "exampleEn": str((m.get("exampleEn") or ex.get("en") or "") if isinstance(ex, dict) else (m.get("exampleEn") or "")).strip(),
            "exampleZh": str((m.get("exampleZh") or ex.get("zh") or "") if isinstance(ex, dict) else (m.get("exampleZh") or "")).strip(),
        })
    meanings = [m for m in meanings
                if m["pos"] or m["zh"] or m["exampleEn"] or m["exampleZh"]]

    phrases = []
    for p in (obj.get("phrases") or []):
        if isinstance(p, dict):
            phrases.append({"en": str(p.get("en") or p.get("phrase") or "").strip(),
                            "zh": str(p.get("zh") or p.get("translation") or "").strip()})
        else:
            phrases.append({"en": str(p or "").strip(), "zh": ""})
    phrases = [p for p in phrases if p["en"] or p["zh"]][:5]

    variants = []
    for v in (obj.get("variants") or []):
        if isinstance(v, dict):
            variants.append({"word": str(v.get("word") or v.get("en") or "").strip(),
                             "pos": str(v.get("pos") or "").strip(),
                             "zh": str(v.get("zh") or "").strip()})
        else:
            variants.append({"word": str(v or "").strip(), "pos": "", "zh": ""})
    variants = [v for v in variants if v["word"] or v["zh"]][:8]

    ety = obj.get("etymology") if isinstance(obj.get("etymology"), dict) else {}
    related = []
    for r in (ety.get("related") or []):
        if isinstance(r, dict):
            related.append({"word": str(r.get("word") or "").strip(),
                            "pos": str(r.get("pos") or "").strip(),
                            "zh": str(r.get("zh") or "").strip()})
        else:
            related.append({"word": str(r or "").strip(), "pos": "", "zh": ""})
    related = [r for r in related if r["word"]][:6]

    etymology = {
        "root": str(ety.get("root") or "").strip(),
        "origin": str(ety.get("origin") or "").strip(),
        "prefix": str(ety.get("prefix") or "").strip(),
        "suffix": str(ety.get("suffix") or "").strip(),
        "tip": str(ety.get("tip") or "").strip(),
        "related": related,
    }
    return {
        "v": 3,
        "en": w["en"],
        "zh": w["zh"],
        "phonetic": w.get("phonetic") or "",
        "meanings": meanings,
        "variants": variants,
        "phrases": phrases,
        "etymology": etymology,
        "generatedAt": now_iso(),
    }


# ---------------- SSH / 隧道（与 deploy.py 相同模式） ----------------
def ssh_connect():
    proc = subprocess.Popen(
        ["cloudflared", "access", "tcp", "--hostname", TUNNEL_HOSTNAME,
         "--url", f"127.0.0.1:{TUNNEL_PORT}"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(4)
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    # tunnel 把远程 22 端口映射到本机 127.0.0.1:12230；连本机监听地址而非 hostname
    cli.connect("127.0.0.1", port=TUNNEL_PORT,
                username=SSH_USER, password=SSH_PASS, timeout=15)
    return cli, proc


def ssh_run(cli, cmd):
    _i, o, e = cli.exec_command(cmd)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    return code, out, err


def ssh_state_get(cli, key):
    url = PI_STATE_URL + "?" + urllib.parse.urlencode({"key": key})
    code, out, err = ssh_run(cli, f"curl -s '{url}'")
    if code != 0:
        raise SystemExit(f"服务器取 {key} 失败：{err}")
    try:
        return json.loads(out)
    except Exception as exc:
        raise SystemExit(f"服务器响应非 JSON：{out[:300]} / {exc}")


def cmd_fetch(args):
    cli, proc = ssh_connect()
    try:
        study = ssh_state_get(cli, KEY_STUDY)
        cache = ssh_state_get(cli, KEY_KNOWLEDGE)
    finally:
        cli.close()
        proc.kill()

    os.makedirs(OUT_DIR, exist_ok=True)
    study_obj = {}
    try:
        study_obj = json.loads(study.get("value") or "{}")
    except Exception:
        study_obj = {}
    with open(os.path.join(OUT_DIR, SERVER_STUDY), "w", encoding="utf-8") as f:
        json.dump(study_obj, f, ensure_ascii=False)
    cache_obj = {}
    if cache.get("ok") and cache.get("value"):
        try:
            cache_obj = json.loads(cache["value"])
        except Exception:
            cache_obj = {}
    with open(os.path.join(OUT_DIR, SERVER_CACHE), "w", encoding="utf-8") as f:
        json.dump(cache_obj, f, ensure_ascii=False)
    print(f"已拉取：{SERVER_CACHE}（{len(cache_obj)} 条缓存）")
    print(f"已拉取：{SERVER_STUDY}（apiKey={'有' if isinstance(study_obj, dict) and study_obj.get('apiKey') else '无'}）")


def resolve_jsonl(st):
    p = st.get("jsonl")
    if p and os.path.exists(p):
        return p
    base = st.get("batch_id") or ""
    cand = os.path.join(OUT_DIR, "cet6-batch-1.jsonl")
    cand2 = os.path.join(OUT_DIR, "cet6-batch-2.jsonl")
    if os.path.exists(cand):
        return cand
    if os.path.exists(cand2):
        return cand2
    raise SystemExit("找不到对应 jsonl")


# ---------------- 应用结果 / 合并 / 写回 ----------------
def cmd_apply(args):
    key = resolve_key(args)
    if args.id:
        batch_ids = [args.id]
    else:
        states = load_states()
        if args.all:
            batch_ids = [s["batch_id"] for s in states]
        elif states:
            batch_ids = [states[-1]["batch_id"]]
        else:
            raise SystemExit("没找到 batch；用 --id 指定")
    if not batch_ids:
        raise SystemExit("无事可应用")

    words = load_words_map()
    merged = {}
    if os.path.exists(os.path.join(OUT_DIR, SERVER_CACHE)):
        with open(os.path.join(OUT_DIR, SERVER_CACHE), "r", encoding="utf-8") as f:
            merged = json.load(f)
    new_count = 0
    fail = []
    for bid in batch_ids:
        info = sf_get("/batches/" + bid, key)
        status = info.get("status")
        print(f"{bid} status={status}", flush=True)
        if status != "completed":
            print("  未完成，跳过（可稍后再 --apply）", flush=True)
            continue
        out_fid = info.get("output_file_id")
        err_fid = info.get("error_file_id")
        err_any = 0
        if err_fid:
            er = sf_download_text(err_fid, key)
            err_any = len([ln for ln in er.splitlines() if ln.strip()])
            print(f"  错误行：{err_any}", flush=True)
        if not out_fid:
            continue
        text = sf_download_text(out_fid, key)
        parsed = 0
        for ln in text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                rec = json.loads(ln)
            except Exception:
                fail.append((bid, "?", "输出行非法 JSON"))
                continue
            cid = rec.get("custom_id")
            m = re.match(r"^w(\d{5})$", cid or "")
            if not m:
                fail.append((bid, cid, "custom_id 无法识别"))
                continue
            idx = int(m.group(1))
            if idx >= len(words):
                fail.append((bid, cid, f"序号越界 {idx}"))
                continue
            w = words[idx]
            resp = (rec.get("response") or {})
            # SiliconFlow 输出行是 {"custom_id","response":{"body":{...chat completion...}}}，
            # response 内没有 status_code 字段；body 本身就是完整响应。若偶尔出现 status_code 则尊重它。
            sc = resp.get("status_code")
            if sc is not None and sc != 200:
                fail.append((bid, cid, f"响应状态 {sc}"))
                continue
            body = resp.get("body") if isinstance(resp.get("body"), dict) else {}
            content = ""
            try:
                content = (body.get("choices") or [{}])[0]["message"]["content"]
            except Exception:
                fail.append((bid, cid, "响应缺 choices"))
                continue
            try:
                raw = extract_json(content)
                entry = normalize(w, raw)
            except Exception as exc:
                fail.append((bid, cid, str(exc)))
                continue
            merged[w["en"].lower()] = entry
            new_count += 1
            parsed += 1
        print(f"  {bid}：解析 {parsed} 条", flush=True)

    if not args.push:
        p = os.path.join(OUT_DIR, MERGED)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(p)
        print(f"合并后共 {len(merged)} 条（新增 {new_count}），未写回：{p}（{size} 字节）")
        if fail:
            print(f"失败 {len(fail)} 条，前 10：")
            for f_ in fail[:10]:
                print("  ", f_)
        return

    merged_obj = copy.deepcopy(merged)
    merged_json = json.dumps(merged_obj, ensure_ascii=False, separators=(",", ":"))
    size = len(merged_json.encode("utf-8"))
    print(f"合并后共 {len(merged)} 条（新增 {new_count}），约 {size} 字节，开始写回 Pi…")

    cli, proc = ssh_connect()
    try:
        # 备份（与 server.py kv_history 相同的保留 30 份）+ 写值
        push_py = (
            "import sqlite3, json\n"
            f"db = {PI_DB!r}\n"
            f"key = {KEY_KNOWLEDGE!r}\n"
            "val_file = '/tmp/pregen-merged.json'\n"
            "with open(val_file, 'r', encoding='utf-8') as fh:\n"
            "    value = fh.read()\n"
            "conn = sqlite3.connect(db)\n"
            "old = conn.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()\n"
            "if old is not None:\n"
            "    conn.execute('INSERT INTO kv_history(key, value) VALUES(?, ?)', (key, old[0]))\n"
            "    conn.execute('DELETE FROM kv_history WHERE key=? AND id NOT IN "
            "(SELECT id FROM kv_history WHERE key=? ORDER BY id DESC LIMIT 30)', (key, key))\n"
            "conn.execute('INSERT INTO kv(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP', (key, value))\n"
            "conn.commit()\n"
            "row = conn.execute('SELECT length(value) FROM kv WHERE key=?', (key,)).fetchone()\n"
            "conn.close()\n"
            "print('wrote ok, length=', row[0] if row else -1)\n"
        )
        val_file = "/tmp/pregen-merged.json"
        py_file = "/tmp/pregen-push.py"
        sftp = cli.open_sftp()
        with sftp.open(val_file, "w") as f:
            f.write(merged_json)
        with sftp.open(py_file, "w") as f:
            f.write(push_py)
        sftp.close()
        code, out, err = ssh_run(cli, f"python3 {py_file}")
        print(out.strip() or err.strip()[:500])
        if code != 0:
            raise SystemExit(f"写回失败 code={code}：{err[:500]}")
        # 验证
        v = ssh_state_get(cli, KEY_KNOWLEDGE)
        try:
            val = json.loads(v["value"])
            print(f"验证：服务器 ces6knowledge.v1 现 {len(val)} 条（ok={v.get('ok')}）")
        except Exception as exc:
            print("验证异常：", exc, str(v)[:200])
    finally:
        cli.close()
        proc.kill()


# ---------------- 写回（读本地合并文件，SSH 直写 sqlite） ----------------
def cmd_push(args):
    """读本地 merged-cache.json，经 tunnel 直写服务器 cet6knowledge.v1。
    与 server.py 的 kv_history 备份（保留 30 份）逻辑一致；先备份旧值再写。
    绕过 HTTP PUT 的 8MB 上限。"""
    src = args.src or os.path.join(OUT_DIR, MERGED)
    if not os.path.exists(src):
        raise SystemExit(f"合并文件不存在：{src}")
    with open(src, "r", encoding="utf-8") as f:
        merged = json.load(f)
    merged_json = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
    size = len(merged_json.encode("utf-8"))
    print(f"读入 {len(merged)} 条（约 {size} 字节），开始写回 Pi…")

    push_py = (
        "import sqlite3\n"
        f"db = {PI_DB!r}\n"
        f"key = {KEY_KNOWLEDGE!r}\n"
        "val_file = '/tmp/pregen-merged.json'\n"
        "with open(val_file, 'r', encoding='utf-8') as fh:\n"
        "    value = fh.read()\n"
        "conn = sqlite3.connect(db)\n"
        "old = conn.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()\n"
        "if old is not None:\n"
        "    conn.execute('INSERT INTO kv_history(key, value) VALUES(?, ?)', (key, old[0]))\n"
        "    conn.execute('DELETE FROM kv_history WHERE key=? AND id NOT IN "
        "(SELECT id FROM kv_history WHERE key=? ORDER BY id DESC LIMIT 30)', (key, key))\n"
        "conn.execute('INSERT INTO kv(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP', (key, value))\n"
        "conn.commit()\n"
        "row = conn.execute('SELECT length(value) FROM kv WHERE key=?', (key,)).fetchone()\n"
        "conn.close()\n"
        "print('wrote ok, length=', row[0] if row else -1)\n"
    )
    cli, proc = ssh_connect()
    try:
        val_file = "/tmp/pregen-merged.json"
        py_file = "/tmp/pregen-push.py"
        sftp = cli.open_sftp()
        with sftp.open(val_file, "w") as f:
            f.write(merged_json)
        with sftp.open(py_file, "w") as f:
            f.write(push_py)
        sftp.close()
        code, out, err = ssh_run(cli, f"python3 {py_file}")
        print(out.strip() or err.strip()[:500])
        if code != 0:
            raise SystemExit(f"写回失败 code={code}：{err[:500]}")
        # 验证
        v = ssh_state_get(cli, KEY_KNOWLEDGE)
        try:
            val = json.loads(v["value"])
            print(f"验证：服务器 cet6knowledge.v1 现 {len(val)} 条（ok={v.get('ok')}）")
        except Exception as exc:
            print("验证异常：", exc, str(v)[:200])
    finally:
        cli.close()
        proc.kill()


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser(description="SiliconFlow Batch 批量预生成知识卡")
    ap.add_argument("--key", help="SiliconFlow API Key（默认取环境变量或 --fetch 拉的服务器配置）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("fetch", help="经 tunnel 拉取服务器当前缓存 + 用户 AI 配置")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("gen", help="读 cet6.json，生成 jsonl 分批文件 + words map")
    p.add_argument("--skip-existing", action="store_true", help="跳过服务器缓存中已有效的词")
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("sub", help="上传 jsonl 并创建 batch")
    p.add_argument("sub", help="jsonl 文件路径（如 scripts/batch/cet6-batch-1.jsonl）")
    p.set_defaults(func=cmd_sub)

    p = sub.add_parser("poll", help="轮询 batch 状态")
    p.add_argument("--id", help="batch id，缺省轮询所有已存状态")
    p.add_argument("--wait", type=int, default=0, help="每 N 秒轮询直到全部结束（0=只查一次）")
    p.set_defaults(func=cmd_poll)

    p = sub.add_parser("apply", help="下载结果、归一化、合并，可选写回 Pi")
    p.add_argument("--id", help="batch id，缺省用最新状态")
    p.add_argument("--all", action="store_true", help="合并全部已完成 batch")
    p.add_argument("--push", action="store_true", help="合并结果经 tunnel 写回服务器（默认只落盘待审）")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("push", help="读本地合并文件，经 tunnel直写服务器 sqlite")
    p.add_argument("src", nargs="?", default=None,
                   help="合并 JSON 路径（缺省 scripts/batch/merged-cache.json）")
    p.set_defaults(func=cmd_push)

    args = ap.parse_args()
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR, exist_ok=True)
    args.func(args)


if __name__ == "__main__":
    main()