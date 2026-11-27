# 官方文档与流程契约核验记录

核验时间：2026-11-24，北京时间。范围：公开官方文档网站、公开页面脚本及官方自助服务文章索引。全部为只读操作；没有使用、复制或向文档网站发送 NeoCRM 凭据，也没有提交任何 CRM 业务动作。

## 本次确认的事实

官方 API 文档是需要登录的 SPA。独立 Chrome 会话打开用户此前提供的文档入口后，实际跳转到销售易 SSO 登录页面，未取得文档正文。不能将仅能打开 SPA 或 HTTP 200 解释为文档接口调用成功。

| 资源 | 本次结果 | 可以证明什么 |
|---|---|---|
| `https://doc.xiaoshouyi.com/` | HTTP 200，17,204 字节 HTML | 官方文档 SPA 当前可访问 |
| `https://doc.xiaoshouyi.com/js/app.a2478370.js` | HTTP 200，146,147 字节 | 当前 SPA 的实际文档 API baseURL 和请求定义 |
| `https://docadmin.ingageapp.com/doc/docPro/getOne?id=1561` | HTTP 200，业务 `code=-2`、`error=401`、`msg=登录超时` | 实际 API 地址正确，但当前没有文档登录态；不是成功读取正文 |
| `POST https://docadmin.ingageapp.com/doc/apiDoc/get` | 同样返回登录超时，75 字节 | 目录查询也要求有效文档登录态 |
| `POST https://docadmin.ingageapp.com/doc/git/getHTMLData` | 同样返回登录超时，75 字节 | 文档正文读取也要求有效文档登录态 |
| 官方自助网站 FAQ 原文 | 静态获取及 Chrome 均返回 HTTP 502 | 本次未成功读取原文，搜索索引只能作为候选线索 |

本次没有尝试绕过登录校验，也没有用 CRM Bearer Token 跨服务冒充文档登录态。现有 CLI 的 CRM 登录成功不证明具备文档网站的 SSO 会话。

## 文档 API 根地址已纠正

当前官方页面脚本中的 Axios 配置明确为：

```text
baseURL: https://docadmin.ingageapp.com/doc/
```

因此此前对 `https://doc.xiaoshouyi.com/docPro/...` 的同域 404 不能解释为官方接口不存在。已确认的文档读取定义为：

```text
GET  /docPro/getOne?id=<documentId>
POST /docPro/get
POST /docPro/searchAll
POST /apiDoc/get
POST /git/getHTMLData
POST /git/getJsonData
```

这些是文档服务接口，不能用于工单操作，也不证明任何 CRM 生命周期动作可执行。官方页面在正文查看器中使用以下结构请求 HTML：

```json
{
  "url": "/concepts/api_apiIntroduction.html",
  "dir": "output_1778036679844",
  "innerPath": ""
}
```

`url`、`dir` 来自用户此前的文档 URL；真实 `innerPath` 要由有权读取的文档详情返回。上述请求实际被登录校验拒绝，不能认为空 innerPath 是正确的完整正文定位。仅凭静态资源根路径也不能猜出该版本的完整文档目录；对已知目录构造的直接 HTML 地址本次返回 404。

当前文档服务使用自身的 `Admin-Token` Bearer 认证，脚本的响应拦截器在 `code=-2` 时执行登录失效处理。本次未读取或输出该 Token。

## 工单与 creekflow 候选的证据边界

官方自助服务的搜索索引中，标题“工作流的提交申请接口怎么调用？”提到：

```text
/rest/data/v2.0/creekflow/workflowInstance/submitByProcApiKey
```

索引来源：

[问答中心](https://service.xiaoshouyi.com/portal.php?mod=topic&topicid=6)

搜索索引另包含 `entityApiKey` 等入参片段，但原文获取失败，未掌握完整 schema、权限、返回码和副作用。该线索只说明存在值得核验的官方工作流提交接口，不能替代 `fieldJob` 创建或关闭契约，也不能用于真实试写探测。

本次公开文档检索没有取得以下接口的官方正文：

```text
/rest/data/v2.0/creekflow/approval/objectData/submitChooser/fieldJob
/rest/data/v2.0/creekflow/task/actions/getPermission
/rest/data/v2.0/creekflow/task/actions/preProcessor
/rest/data/v2.0/creekflow/approval/userTaskLog/fieldJob
```

相邻 `crm-ticket-service` 中存在来自旧 FastGPT 导出的对应实现，但其 AGENTS.md 自己明确标注未独立核验。本次未把这些源码候选升级为已核验生产契约，没有请求 `preProcessor`、`userTaskLog`、提交、同意或关闭接口。尤其不能根据 `getPermission`、`preProcessor` 的函数名就认定其必然无副作用。

公开镜像 `Doraliudd/OpenAPIGuide` 的 README 可以读取，但它不是当前官方文档正文，也不能提供租户具体业务类型、条件必填、动作权限或副作用的证据。

## 对后续接入的具体影响

1. 当前已掌握正确的官方文档 API 入口，后续应在有权使用的文档登录会话内读取正文，不再重复同域猜路径。
2. `fieldJob` 编号、时间、引用字段的读取映射可以独立依靠真实对象元数据与有界回读验证，不必等待文档登录问题解决。
3. 创建、分派、处理记录、解决、关闭及各分支仍必须取得真实动作/表单/权限证据。不能因为旧导出中存在一个关闭链就推导所有业务类型均可用。
4. 当前 CRM 新建明确标记的测试工单已经由用户选定测试范围；这不会自动补齐未知业务类型、条件必填或动作协议。最终测试请求应先依据实际表单和接口形成可审核 payload，再按已有确认机制执行。

## 公开证据文件

原始公开响应保存在 `/tmp/xsy-public-docs/`，不含 CRM 记录或认证凭据。文件用途为本次接口研究，完成复核后可清理；这不是应用运行时依赖。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `app.js` | 146,147 字节 | `bc065447b0d37f235ccf74e412f71a8671533993fe005fd1710de83969b11a58` |
| `viewer.js` | 192,857 字节 | `afbda107b7caf2f22cc5ca80f881507111255819f320fac6967c5aeaff5a1b73` |
| `api-index.js` | 6,289 字节 | `7d132910fdb5e0c6d171be2990f573ba1d1a609aabb8585cdeefd053d25fd336` |
| `getOne.txt` | 75 字节 | `9c27f1ba61d0bab153187b8077d071054c7c6e83c3dd755adac9ed188a909d88` |

浏览器使用独立会话 `xsy-official-docs`，核验结束后关闭，不影响其他浏览器会话。

## 2026-11-25：CRM 公开前端独立证据路线

本轮仅以未登录 HTTP 请求读取用户指定的 `https://crm.xiaoshouyi.com/bff/neoweb/` 及其 HTML 明确引用的前端主包，没有携带 Token/Cookie，没有访问任何新的 CRM 业务端点。公开响应保存在 `/tmp/xsy-crm-public-20261125/`。

| 资源 | HTTP/大小 | SHA-256 |
|---|---|---|
| CRM 公开 HTML | 200 / 23,117 字节 | `a4077706f39250c52992ee77d6a95dc1c16f415c6c40b6775c8f7a5b544507fd` |
| `https://neors.ingageapp.com/projects/apps-ingage-web/2023/build/static/js/main.ca98f969.js` | 200 / 269,831 字节 | `451fba5d0dd86195b11d40d5a0bbd8e2507d9acb9363cbeb14bfdc6508c599a5` |

该主包主要包含 webpack 运行时、初始化和路由/异步模块索引。在已读取范围内，`fieldJob`、`getPermission`、`submitChooser`、`preProcessor` 均无命中；这只描述当前主包，不代表整个前端不存在这些实现。

主包可定位以下后续静态调查入口，但本轮未进一步下载它们，也没有据此请求猜测的 CRM 接口：

| 模块索引 | 当前主包记录的 hash | 证据位置 |
|---|---|---|
| `src_pages_paas_entityForm_tsx` | `fd843a2b` | `main.js` 字符偏移约 105,931 |
| `src_pages_paas_entityGrid_tsx-static_img_v4_0_no-permission_png` | `b4d9742e` | `main.js` 字符偏移约 105,780 |
| `src_base_stores_dayoneLayouts_index_ts` | `39514ac8` | `main.js` 字符偏移约 100,215 |
| `static_source_platform_manager_formMgr_js` | `72f717bd` | webpack 异步模块索引；尚未核验模块正文 |

主包中确实存在一个 `fetch` 读取布局调用（字符偏移约 11,185）：

```text
GET /rest/data/v2.0/layouts/currentUserLayout
    ?deviceType=3
    &layoutType=7
    &checkFeature=aiWorkbench
    &currentPackId=<P>
```

上下文将结果写入 `window.__aiWorkbenchEnabled`，这是 AI 工作台布局检查，不能当作 `fieldJob` 创建布局或用户创建权限的读取协议。本轮没有调用它。

本轮已读取 reverse-engineer-anything 技能及其连接恢复说明；环境没有 REA 工具或 `rea` CLI，按任务约束未安装依赖。上述结果来自普通 HTTP/文本静态检查，不是 REA Evidence，也不是运行时请求抓取。源码模块名只能作为调查候选，不应登记为生产动作已核验。

当前结论仍是：创建协议的候选可以从官方 SDK 或已有实现获得；解除真实创建的阻断，需要当前业务类型的实际表单/默认值/条件必填、用户级允许结果及 disabled 语义。当前主包的有限静态证据未补齐这些事实，不能据此解除 `prepare` 的 blocked 状态。

### 限定三个异步模块的后续检查

根据 HTML 中的 `window.publicPath` 与主包 webpack `u/p` 规则，另外只读取以下三个公开模块，未再追更多依赖，也未请求模块中提到的 CRM 业务端点：

| 模块与公开路径（公共前缀见下） | 字节 | SHA-256 |
|---|---:|---|
| `src_base_stores_dayoneLayouts_index_ts.39514ac8.js` | 10,805 | `f026971d4aefd836cc10a732cf5a2e46d87e849418d2394a0bb9f874f0a6a328` |
| `static_source_platform_manager_formMgr_js.72f717bd.js` | 16,708 | `f98cb62e7bbdd1cfebcf5b19929872e977942c9ba09be2ea80d087e051b7b0e0` |
| `src_pages_paas_entityForm_tsx.fd843a2b.js` | 3,301 | `a1c043bffa4099be7ef7ac83d91fa1681b89b81cff559722dbe99ab19c32dde9` |

公共前缀：`https://neors.ingageapp.com/projects/apps-ingage-web/2023/build/static/js/`。本地分别保存为 `dayoneLayouts.js`、`formMgr.js`、`entityForm.js`。

`dayoneLayouts.js` 在字符偏移约 10,566 明确包含：

```text
GET /json/crm_index/load-layout.action?deviceType=3
PRM 分支：GET /rest/prm/v2.0/index/layout?deviceType=6
```

调用上下文是首页布局，不是 `fieldJob` 新建表单，不能用它验证创建权限。`formMgr.js` 仅取得控件配置中的 `userPermission` 并加载其他控件模块，没有找到独立的表单或用户创建权限 HTTP 请求。

`entityForm.js` 是创建表单 schema 的中转层，明确从路由参数取 `objectApiKey`、`businessType`、`busiTypeId`、`formType`，且 `formType` 默认为 `create`。构建 `EntityForm` 或 `EntityFormX` 的请求参数形状为：

```text
requestParams: {
  objectApiKey: o,
  businessType: f === "undefined" ? "" : f,
  formType: r,
  busiTypeId: s,
  recordId: n.recordId,
  ...n.requestParams,
  ...n.requestInfo
}
```

该模块通过 `EntityManager.isObjectForm20(objectApiKey)` 选择表单分支，但不包含实际 HTTP 路径、方法、用户权限结果、默认值或条件必填规则。因此，这些参数名是静态页面证据；实际布局读取协议和目标业务类型的规则仍需在有权访问的创建页面中取得，不能从模块名或参数名推导。
