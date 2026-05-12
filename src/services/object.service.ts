// 通用对象服务 — 封装销售易 CRM REST API CRUD 操作

import { getApiClient } from "../api/client.js";
import { classifyError } from "../api/errors.js";
import type { ApiResponse, DescribeResult, QueryResult } from "../types/index.js";
import { API_OBJECTS_PREFIX, DESCRIBE_PREFIX, QUERY_PATH } from "../config.js";

// 获取对象字段元数据
export async function describeObject(
  apiKey: string
): Promise<ApiResponse<DescribeResult>> {
  try {
    const client = getApiClient();
    const response = await client.get<ApiResponse<DescribeResult>>(
      `${DESCRIBE_PREFIX}/${apiKey}/description`
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}

// 获取单条记录
export async function getObject(
  apiKey: string,
  id: string
): Promise<ApiResponse> {
  try {
    const client = getApiClient();
    const response = await client.get<ApiResponse>(
      `${API_OBJECTS_PREFIX}/${apiKey}/${id}`
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}

// 创建记录
export async function createObject(
  apiKey: string,
  data: Record<string, unknown>
): Promise<ApiResponse> {
  try {
    const client = getApiClient();
    const response = await client.post<ApiResponse>(
      `${API_OBJECTS_PREFIX}/${apiKey}`,
      { data }
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}

// 更新记录
export async function updateObject(
  apiKey: string,
  id: string,
  data: Record<string, unknown>
): Promise<ApiResponse> {
  try {
    const client = getApiClient();
    const response = await client.patch<ApiResponse>(
      `${API_OBJECTS_PREFIX}/${apiKey}/${id}`,
      { data }
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}

// 删除记录
export async function deleteObject(
  apiKey: string,
  id: string
): Promise<ApiResponse> {
  try {
    const client = getApiClient();
    const response = await client.delete<ApiResponse>(
      `${API_OBJECTS_PREFIX}/${apiKey}/${id}`
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}

// SQL 查询
export async function queryObjects(
  sql: string
): Promise<ApiResponse<QueryResult>> {
  try {
    const client = getApiClient();
    const response = await client.get<ApiResponse<QueryResult>>(
      QUERY_PATH,
      { params: { q: sql } }
    );
    return response.data;
  } catch (err) {
    throw classifyError(err);
  }
}
