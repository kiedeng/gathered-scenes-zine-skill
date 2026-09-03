# 实现与范围

本技能的指令与脚本为用户的人像实景拼贴需求编写，独立命名，不是 Zeejay0 上游技能的官方新版。1.1.0 修正了完整带人物的默认流程；1.2.0 增加保留源脸高频细节、协调低频光色的 harmonized 模式，同时保留严格原像素模式。

- 当前环境的图像生成工具：负责完整拼贴设计和默认模式下的脸部高保真编辑。
- MediaPipe: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/python — 可选人脸关键点定位，不建立人物身份。
- Sharp: https://sharp.pixelplumbing.com/ — 可选裁剪、规范化、回贴、导出与对照图。
- Pixelmatch: https://github.com/mapbox/pixelmatch — 严格模式的辅助差异图，不是美学或身份评分。
- 官方模型来源和校验值保留在 assets/model.json。

几何拟合、原图采样、遮罩、频率协调、锁定与检查由本地 source-face 程序执行。1.1.0 增加外围过渡环的自适应混合；1.2.0 使用归一化盒式低通估计源脸与目标低频，只把有限低频差加入源脸。Python 负责定位，不负责创造背景。
