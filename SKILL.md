---
name: claude-limit-fallback
description: "Claude 구독 한도(5시간·주간)를 다 쓰면 자동으로 OmniRoute로 전환해 같은 대화를 무료/다른 AI로 이어가게 설치·점검한다. '토큰 다 쓰면 omniroute로', '한도 끝나면 자동 전환', 'claude limit fallback' 요청, 또는 이 설정이 동작하는지 확인할 때 사용. Windows + Claude Code 기준."
---

# claude-limit-fallback

## 이 스킬이 하는 일
Claude 구독 한도(5시간·주간)가 바닥나 Claude Code 턴이 `rate_limit` 오류로 끝나는 순간:
1. `StopFailure` 훅이 실행된다.
2. 새 창("Claude via OmniRoute")이 뜨고, 방금 대화를 **복사해 이어받아**(`--resume --fork-session`) OmniRoute 경유로 연다.
3. "중단된 작업을 이어서 계속하라"를 자동으로 보낸다.
4. OmniRoute 콤보 `claude-fallback`이 무료 모델부터 순서대로 시도한다(codestral → OpenRouter 무료 → Gemini Flash → Groq → 유료).

원래 대화는 건드리지 않는다. 같은 세션은 30분 안에 다시 띄우지 않고, 이미 OmniRoute 경유인 세션은 무시한다.
수동 실행: 바탕화면 `Claude-OmniRoute.bat`.

## 설치 (이 순서대로, 새로 조사하지 않는다)
스크립트는 모두 이 스킬의 `scripts/`에 있다. 사람 몫은 `doorstep-handoff` 방식으로 넘긴다.

1. **자동 설치**: `node scripts/install.js`
   - OmniRoute가 없으면 npm으로 설치하고, 훅 스크립트를 `~/.claude/hooks/`에 복사한다.
   - `settings.json`에 StopFailure 훅을 등록한다(백업을 만들고, 기존 설정은 보존).
   - 바탕화면 `.bat`을 만들고 OmniRoute 서버를 세션과 분리해 켠다.
   - 다시 실행해도 안전하다.
   - 자동 모드에서는 `settings.json` 수정이 분류기에 막힌다. 사용자에게 수동 모드로 바꿔 승인받는다.
2. **제공자 키** (사람 몫): 로그인된 Chrome에서 `http://localhost:20128/dashboard/providers/new` → "API 키 제공자" → 제공자 카드 → 키 칸에 커서까지 대령한다.
   - 대시보드 비밀번호 기본값은 OmniRoute 설치 폴더 `.env`의 `INITIAL_PASSWORD`(보통 `CHANGEME`)다.
   - 필수: **Mistral**(무료, codestral만 동작). 권장: OpenRouter, Gemini(AI Studio), Groq.
   - 키는 채팅으로 받지 않는다.
3. **콤보·설정**: 로그인된 대시보드 탭에서 `scripts/omniroute-setup.browser.js` 내용을 javascript로 실행한다.
   - 관리 API는 로그인 쿠키가 필요해서 CLI로는 401이 난다.
   - `claude-fallback` 콤보를 만들거나 갱신하고, thinking-budget을 `auto`로 바꾼다.
4. **검증**: `node scripts/verify.js --e2e`
   - 모든 줄이 PASS여야 완료다.
   - `--e2e`는 가짜 한도 서버로 실제 훅을 발생시키고, 새 창이 무료 모델로 작업을 끝내는지 대화 기록에서 확인한다.
   - 첫 실행에는 새 창에서 폴더 신뢰 확인(사람 몫)이 뜬다. 이미 신뢰한 폴더에서 하려면 `--dir <폴더>`를 쓴다.
   - 끝나면 테스트 창을 닫는다.

## 확인된 사실 (2026-09, 재조사 불필요)
- Claude Code는 한도 초과 시 `StopFailure`를 `error:"rate_limit"`로 보낸다(가짜 429로 실측).
- Claude Code 요청 1건은 입력 약 8만 토큰이다. 그래서 분당 토큰이 작은 무료 제공자는 쓸 수 없다.
  - Mistral 무료: `codestral`만 동작(분당 62.5만 토큰, 초당 2회). small/medium/devstral은 429, large는 403.
  - Groq 무료: 분당 8천 토큰이라 Claude Code 요청 불가. 짧은 호출만 된다.
  - OpenRouter `:free`: 인증은 되지만 상류가 자주 429/빈 응답(하루 50회).
  - Gemini 무료: 곧바로 쿨다운된다.
- 제외: Cerebras(카드 필요), GitHub Models(종료), Cohere(비상업), Kiro·Qoder류(계정 우회 → 정지 위험).

## 함정
- 훅이 띄우는 창은 `explorer.exe`로 연다. 앱 프로세스 트리(job)에 묶이면 세션과 같이 죽는다. OmniRoute 서버도 같은 이유로 `omniroute-serve.vbs`를 explorer로 연다.
- `.cmd`·`.bat`은 ASCII만 쓴다(cmd가 OEM 코드페이지로 읽는다). 작업 폴더는 base64로 넘긴다.
- `ArtifactData` 도구 스키마의 `prefixItems`를 Gemini 변환이 거부한다 → `--disallowedTools ArtifactData`.
- thinking-budget이 `auto`가 아니면 codestral이 `reasoning_effort is not enabled`로 거절한다.
- OmniRoute 서버가 꺼진 채 대시보드에서 키를 저장하면 저장되지 않는다. `omniroute providers list`로 확인한다.
- 새 창은 대화형 CLI라, **한 번도 신뢰하지 않은 폴더(홈 폴더 포함)에서는 "폴더 신뢰" 확인을 기다린다**. 자리를 비운 상태라면 여기서 멈춘다.
- 무료 모델은 Claude보다 답 품질이 낮다.
- 미확인: 진짜 한도 응답, 그리고 데스크톱 앱 세션에서의 발생은 가짜 서버로 재현할 수 없다.
