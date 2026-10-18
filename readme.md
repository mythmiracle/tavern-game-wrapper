# Wayward Tavern 실행기

Wayward Tavern 등 `localStorage`를 사용하는 HTML 게임을 데스크톱 앱으로 실행하는 Neutralino.js 기반 실행기입니다. 게임 HTML을 선택해 실행하고, 세이브와 모드 설정을 SQLite에 보관할 수 있습니다.

## 주요 기능

- 게임 HTML 선택과 실행, 게임 파일 교체, 자동 시작 설정
- 세이브와 모드 설정의 자동 저장 및 종료 전 저장 확인
- JSON 백업 파일 내보내기·불러오기와 브라우저 세이브 이전
- 저장된 데이터 키와 용량 확인
- 대용량 값의 변경 조각 재사용과 저장 무결성 검증

## 시작하기

현재 배포 폴더의 실행 파일은 Windows x64용입니다. 실행 파일과 `neutralino.config.json`, `neutralino.js`, `dexie.js`, 런처·브릿지 파일을 같은 폴더에 두고, 플레이할 게임 HTML을 별도로 준비하세요.

1. `neutralino-win_x64.exe`를 실행합니다.
2. 런처에서 **게임 실행 파일 선택 / 버전 변경**을 눌러 게임의 `.html` 파일을 선택합니다.
3. 기존 백업이 있다면 **백업 파일 불러오기**로 가져옵니다. 새로 시작할 때는 건너뛰어도 됩니다.
4. **게임 시작하기**를 누릅니다.

**다음 실행부터는 이 화면을 건너뛰고 바로 게임 시작하기**를 선택하면 이후 실행에서 런처를 건너뜁니다. 게임 중 우클릭 메뉴의 **런처 화면으로 돌아가기**에서 게임 파일과 세이브를 다시 관리할 수 있습니다.

실행기는 선택한 게임 옆에 `__neu_bridged_<게임파일명>.html` 실행용 사본을 만듭니다. 원본 게임 HTML은 유지되며, 사본을 만들 수 있도록 게임 폴더에 쓰기 권한이 필요합니다.

창의 X 버튼, 런처의 종료 버튼, 게임 중 우클릭 메뉴의 종료는 모두 저장 확인 후 앱을 종료합니다. 저장에 실패하면 창을 유지하고 오류를 표시합니다.

데스크톱 앱에서는 게임의 PWA용 서비스 워커 등록을 건너뜁니다. 게임 파일은 로컬 서버에서 제공하며, 저장 처리에 사용하는 일반 Worker는 계속 사용할 수 있습니다.

실행기의 게임 실행과 SQLite 저장에는 인터넷 연결이 필요하지 않습니다. `127.0.0.1` 주소는 같은 컴퓨터 내부 통신에 사용합니다. 다만 런처와 백업·복원 도구는 화면 꾸밈용 Tailwind CSS와 Google Fonts를 인터넷에서 불러오므로, 오프라인에서는 화면 배치와 글꼴이 달라질 수 있습니다. 게임이나 모드가 사용하는 외부 서비스의 연결 요구 사항은 별도입니다.

## 다른 사람에게 공유하기

실행기만 배포할 때는 아래 10개 파일을 새 폴더에 복사해 ZIP으로 압축하세요. 모두 같은 폴더에 둡니다.

```text
실행기/
├── neutralino-win_x64.exe
├── neutralino.config.json
├── neutralino.js
├── dexie.js
├── launcher.html
├── neutralino-storage-bridge.js
├── browser-storage-restore.js
├── localstorage-extractor.html
├── icon.png
└── readme.md
```

받는 사람은 쓰기 가능한 폴더에 압축을 풀고 `neutralino-win_x64.exe`를 실행한 뒤 자신의 게임 HTML을 선택하면 됩니다. `extensions/`와 `userdata/`는 실행 시 자동으로 생성됩니다.

다음 항목은 배포에 포함하지 않습니다.

- `userdata/`: 개인 세이브, 선택한 게임 경로와 런처 설정
- `.tmp/`: 테스트 결과와 실제 세이브를 사용한 검증 사본
- `game_mount/`: 현재 컴퓨터의 게임 폴더를 가리키는 연결
- `*.log`, `.git/`: 실행 로그와 개발 이력
- `extensions/`: 실행 시 생성되는 SQLite 백엔드와 관련 파일
- `scripts/`, `tests/`, `storage-chunks.js`, `storage-chunk-worker.js`, `storage-chunk-backend.cs`, `storage-chunk-backend.py`: 개발용 소스와 도구. 실행에 필요한 코드는 브릿지에 내장되어 있습니다.

## 세이브와 백업

세이브와 런처 설정은 실행 폴더의 `userdata`에 보관됩니다.영

| 파일 | 용도 |
| --- | --- |
| `userdata/storage.sqlite` | 세이브와 모드 설정을 보관하는 데이터베이스 |
| `userdata/launcher-config.json` | 선택한 게임 경로와 자동 시작 설정 |
| `userdata/storage.json`, `userdata/blob_*.dat` | 이전 저장 방식의 데이터가 있는 경우 사용하는 이전·복구용 원본 |

런처의 **현재 세이브 백업 저장**으로 JSON 백업을 만들고, **백업 파일 불러오기**로 복원할 수 있습니다. 게임 중에도 우클릭 메뉴에서 백업 기능을 사용할 수 있습니다.

실행 폴더를 옮기거나 폴더 단위로 백업할 때는 앱을 완전히 종료한 뒤 `userdata` 전체를 복사하세요. SQLite의 `-wal`, `-shm`은 정상적인 보조 파일이며, 실행 중에는 아직 본체에 합쳐지지 않은 변경이 `-wal`에 있을 수 있습니다.

### 브라우저에서 플레이하던 세이브 가져오기

1. 런처에서 **인터넷 창으로 백업 도구 열기**를 누르고, 기존에 플레이하던 브라우저에서 도구를 엽니다.
2. 백업 도구에서 데이터를 확인하고 JSON 백업을 내려받습니다.
3. 런처의 **백업 파일 불러오기**로 내려받은 파일을 선택합니다.

백업 도구에 데이터가 나타나지 않으면 런처의 **비상용 자동 백업 명령어 복사**를 사용하세요. 기존 게임을 열었던 브라우저·프로필의 게임 화면에서 개발자 도구 콘솔을 열고 명령어를 실행하면 백업 파일을 받을 수 있습니다.

### 실행기 세이브를 브라우저로 가져가기

1. 런처의 **현재 세이브 백업 저장**으로 JSON 파일을 내보냅니다.
2. **백업·복원 도구 열기**로 게임을 플레이하던 브라우저에서 도구를 엽니다. 게임 탭은 닫고 기존 브라우저 세이브도 먼저 백업해 두세요.
3. 도구의 **복원할 백업 파일 열기**로 JSON을 열고 아래 목록에서 복원할 항목을 선택합니다. 파일을 여는 것만으로 저장소가 바뀌지는 않습니다.
4. **선택한 항목을 로컬 저장소에 복원**을 누릅니다. 저장한 값을 다시 읽어 확인한 뒤 버튼 아래에 복원·검증한 수와 변경한 수를 표시합니다. 실패하면 오류 원인과 되돌리기 결과를 표시하며, 결과 안내는 자동으로 사라지지 않습니다.
5. 원래 게임을 다시 열어 복원한 세이브를 불러옵니다.

브라우저·설정에 따라 도구와 게임의 저장 공간이 분리되어 세이브가 보이지 않을 수 있습니다. 이때는 도구의 **게임에서 복원한 세이브가 보이지 않을 때**를 펼쳐 **게임 탭 복원 명령어 복사**를 누르세요. 원래 게임의 타이틀 화면에서 F12 → 콘솔(Console)에 명령어를 붙여넣고 Enter를 누른 뒤 표시되는 복원 창에서 JSON 파일을 선택하면 됩니다.

선택한 키만 덮어쓰며 다른 키는 유지합니다. 압축된 슬롯을 포함해 백업의 문자열을 그대로 저장합니다. 브라우저 `localStorage`에는 SQLite와 달리 용량 제한이 있어 전체 백업이 들어가지 않을 수 있습니다. 이 경우 변경한 값을 되돌리고 오류를 표시하므로 필요한 슬롯과 설정만 선택해 다시 시도하세요. 되돌리기까지 실패하면 별도로 표시합니다.

명령에는 복원 기능만 들어가며 세이브 본문은 포함하지 않습니다. 외부 서버에서 코드를 내려받거나 세이브를 전송하지 않습니다.

## 프로젝트 구성

```text
.
├── neutralino-win_x64.exe         # Windows 실행 파일
├── neutralino.config.json        # Neutralino 앱 설정
├── neutralino.js                 # Neutralino 클라이언트 라이브러리
├── dexie.js                      # IndexedDB 캐시 라이브러리
├── icon.png                      # 실행기 창 아이콘
├── launcher.html                 # 게임 실행·세이브 관리 화면
├── localstorage-extractor.html   # 브라우저 세이브 백업·복원 도구
├── browser-storage-restore.js    # 브라우저 복원 창과 독립 실행용 콘솔 명령
├── neutralino-storage-bridge.js  # 저장 브릿지와 내장 백엔드 소스
├── storage-chunks.js             # 내용 기반 조각화와 해시 검증
├── storage-chunk-worker.js       # Worker에서 조각 처리
├── storage-chunk-backend.cs      # C# 조각 저장 구현
├── storage-chunk-backend.py      # Python 조각 저장 구현
├── scripts/                     # 소스 추출·동기화 도구
├── tests/                       # 저장·복원·통신 테스트
├── extensions/sqlite/            # 실행 시 생성되는 SQLite 백엔드
├── game_mount/                  # 외부 게임 폴더 연결 경로
└── userdata/                    # 세이브와 런처 설정
```

실행 파일, 일부 런타임 라이브러리와 생성 폴더는 Git 관리 대상에서 제외되어 있습니다. 소스만 체크아웃한 경우 실행에 필요한 파일을 별도로 준비해야 합니다.

## 저장 구조

게임에는 메모리 기반 `localStorage` 인터페이스를 제공합니다. 런처와 게임은 데이터 목록과 작은 값부터 읽으며, 대용량 값은 처음 요청할 때 복원해 메모리에 보관합니다. 게임의 JSON 구조를 해석하거나 재작성하지 않고 문자열을 보존합니다.

WML 등 모드 로더가 `Storage.prototype`에 설치한 읽기·쓰기 훅을 따릅니다. 압축된 세이브는 저장 원문을 유지하고, 게임이 읽을 때 모드 로더가 JSON으로 풀어 전달합니다. 읽기 과정에서 JSON을 다시 압축하거나 DB에 덮어쓰지 않습니다.

변경된 값은 Worker에서 내용 기반 조각으로 나눕니다. 조각은 최소 32KiB, 평균 목표 128KiB, 최대 512KiB이며, 일반 UTF-8 값은 64KiB 이하일 때 인라인으로 저장합니다. SHA-256이 같은 조각은 재사용하고, 새 조각만 최대 1MiB의 바이너리 요청으로 전송합니다.

모든 조각과 세이브 구성을 검증한 뒤 SQLite 트랜잭션으로 새 세이브를 활성화합니다. 저장 중 실패하면 직전 정상 세이브를 유지합니다. 저장 중 발생한 변경은 다음 저장으로 모으며, 종료 시에는 남은 변경의 커밋까지 확인합니다.

기존 `storage.json`·`blob_*.dat`를 이전할 때는 전체 값을 저장하고 재읽은 결과의 SHA-256을 비교합니다. 이전 원본은 보존하며, 이후에는 검증된 SQLite 커밋을 우선합니다. 복구용 데이터와 이전 세이브가 남아 있으면 DB 크기가 현재 세이브 원문보다 클 수 있습니다.

지원되는 Wayward WML 게임에서는 자동저장 객체를 JSON으로 바꾸기 전에 연속 요청을 합칩니다. 마지막 변경 후 250ms를 기다리며, 요청이 계속 들어와도 최대 1초 안에 최신 상태를 한 번 직렬화합니다. JSON으로 반영한 뒤에는 기존 SQLite 저장 주기를 따릅니다. 모드 초기화가 끝난 뒤 저장 계층에 연결하므로 압축 모드의 처리도 유지합니다.

자동저장·수동저장 슬롯을 읽거나 수동저장을 쓰는 시점, 백업 내보내기와 종료·화면 이동 전에는 대기 중인 자동저장을 즉시 반영합니다. 삭제·초기화·백업 복원으로 기존 값을 교체하면 이전 대기 요청을 취소합니다. 게임 중 백업을 복원했다면 이전 게임 상태의 자동저장을 중지하고, 게임이 복원한 데이터를 다시 읽거나 페이지를 새로 열 때 재개합니다. 직렬화나 쓰기에 실패하면 대기 상태를 유지하고 종료 성공으로 처리하지 않습니다. 지원되는 연결 지점을 찾지 못한 게임이나 비동기 저장 계층은 기존 저장 방식을 사용합니다.

한 번 수행하는 대용량 `JSON.stringify()` 비용과 게임의 저장용 객체 정리 비용은 남습니다. 진단용 `window.__storageBridge.getStats().autosaveMetrics`에서 요청 수·직렬화 횟수·합친 요청 수·대기 여부를 확인할 수 있습니다. `coalesceGameAutosave: false`로 최적화를 끌 수 있으며 대기 시간은 `gameAutosaveDebounceMs`, `gameAutosaveMaxWaitMs`로 설정합니다.

## 개발

소스 동기화에는 Node.js를 사용합니다. Windows 백엔드는 .NET Framework C# 컴파일러와 내장 `winsqlite3.dll`을 사용하며, Python `sqlite3` 백엔드도 포함되어 있습니다.

배포 시 백엔드 소스는 `neutralino-storage-bridge.js`에 내장되고, `launcher.html`에는 같은 브릿지의 대체본이 포함됩니다. 다음 순서로 수정하면 생성본과 배포 소스의 차이를 방지할 수 있습니다.

1. 내장 백엔드 소스를 추출합니다.

   ```powershell
   node scripts/storage-sources.cjs export
   ```

2. 수정할 소스를 편집합니다.

   | 수정 대상 | 편집할 파일 |
   | --- | --- |
   | 런처 화면 | `launcher.html`의 화면·런처 코드 |
   | 저장 브릿지 | `neutralino-storage-bridge.js` |
   | 조각화·Worker | `storage-chunks.js`, `storage-chunk-worker.js` |
   | 조각 저장 백엔드 | `storage-chunk-backend.cs`, `storage-chunk-backend.py` |
   | 백엔드의 나머지 코드·실행 스크립트 | 추출된 `extensions/sqlite/` 파일 |

3. 수정한 소스를 브릿지와 런처에 반영합니다.

   ```powershell
   node scripts/storage-sources.cjs sync
   ```

`launcher.html`의 내장 브릿지를 직접 수정하면 다음 동기화 때 덮어써집니다. 추출된 백엔드 파일을 수정한 경우에도 다시 `export`하기 전에 `sync`로 반영하세요.

## 테스트

Windows에서 Node.js, Python 3, .NET Framework C# 컴파일러가 필요합니다. 프로젝트 루트에서 실행합니다.

```powershell
# 저장·복원·이전, 조각 무결성, Worker, 연속 저장, 실패·종료 처리
.\tests\run-storage-tests.ps1

# 실제 C# 데몬의 로컬 HTTP 통신 검증 포함
.\tests\run-storage-tests.ps1 -Http
```

테스트는 임시 폴더에 DB와 데이터를 생성하며 실제 `userdata`를 변경하지 않습니다.

현재 Wayward 세이브를 사용한 대용량 통신·복원 검증은 앱을 종료한 뒤 실행합니다. `userdata/storage.sqlite`의 복사본으로 측정하며, 결과는 `.tmp/chunk-storage/benchmark.json`과 `benchmark-python.json`에 기록됩니다.

```powershell
node tests/chunk-http.cjs
node tests/chunk-http.cjs --python
```

`chunk-http.cjs`의 `--migrate` 옵션은 실제 `userdata`를 변경하는 이전 모드이므로 일반 테스트에 사용하지 않습니다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| 필수 파일 누락 화면이 표시됨 | 실행 폴더에 런처·브릿지·라이브러리가 함께 있는지 확인합니다. |
| SQLite 백엔드가 시작되지 않음 | `extensions/sqlite/compile.log`, `extensions/sqlite/startup.log`를 확인합니다. |
| 게임을 이동한 뒤 실행되지 않음 | 런처에서 게임 HTML을 다시 선택합니다. |
| 저장 또는 복원 오류가 표시됨 | 오류 내용을 확인하고 `userdata`를 보관한 뒤 재시도합니다. 실패한 저장은 완료로 처리되지 않습니다. |
