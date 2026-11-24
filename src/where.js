// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 「去哪一栏」的口径（依据页每一节那行「去哪做」）。
 *
 * 为什么要单独一份数据，不写进 rules.json：
 *   rules.json 的每条证据都要能逐字核到原文快照（validate 的机器底线）。
 *   「挂哪个科」不是指南条文 —— 指南管「该不该查」，医院管「挂哪个号」。
 *   混进 evidence 会出现两种坏结果：要么给科室编一条「指南原文」（造假），
 *   要么整条证据被标成待核实（连"该不该查"也一起废掉）。
 *   所以分开存，并且每条都写明 basis：
 *     guide    = 原文点名了科室或医生资质（可在 sources 里逐字核）
 *     practice = 原文没点名，按国内医院现行科室设置写
 *
 * 页面上只渲染 dept —— 老板 2026-11-22 定稿：「去哪做」这一行只留「科室」，
 * 标签和说明一个都不上。basis 和 note 留在数据里继续给机器用：
 * validate 靠 basis 抽查"给惯例穿依据外衣"，note 是这条科室该怎么用的底稿
 * （要不要单独约、为什么在那做），哪天要放回页面直接取。
 *
 * 这份文件由 scripts/validate.mjs 把关：规则漏一条要报错，sources 的引文
 * 要在快照里逐字找到 —— 和 rules.json 同一套底线。
 */
import whereJson from '../data/where.json' with { type: 'json' };

export const WHERE = whereJson;

/** 一条规则去哪：查 rules，再查 extras（老年综合评估、体型这类不是"规则"的块） */
export const whereOf = (id) => whereJson.rules[id] || whereJson.extras[id] || null;

export const whereExtra = (id) => whereJson.extras[id] || null;

export const BASE_WHERE = whereJson.base;
export const VAX_WHERE = whereJson.vaccines;
export const WHERE_SOURCES = whereJson.sources || [];
