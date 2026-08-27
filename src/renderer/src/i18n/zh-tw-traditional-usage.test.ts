// Script and vocabulary regressions in a converted catalog are invisible to
// verify-localization-catalog, which only checks key parity and interpolation.
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import zhTW from './locales/zh-TW.json'

// The Simplified endonym is the one value that must stay Simplified — it names
// the zh catalog in every locale's language picker (see NATIVE_PICKER_LABELS).
const SIMPLIFIED_ENDONYM_KEY = 'settings.appearance.language.chinese'

// High-frequency characters that only exist in the Simplified set, so any
// pasted Simplified sentence trips at least one of them.
const SIMPLIFIED_ONLY = [
  ...'这为说时过应该关开门问间见现实认识请让语词设计议访证评试读变边选适递远连进运还处备复够头买卖众会传伤价优体举义乐习乡书产亲从仓仪单双发号叶叹听启团园图圣块坏坚坛垄垒壮声壳处备够头夸夺奋奖妇妈宁实宠审写宽宾对寻导寿将尔尘尝尽层属岁岗岛岭峡帅师帐帘帮归当录忆忧怀态总恋恶恼惊惧愿战户执扩扫扬护报担拟拥择挂损换据摆摇携敌数斗断无旧显晒晓术机杀杂权来杨极构枢标栈栋栏树样档桥梦检楼横欢欧残毁毕气汇汉污汤沦沧沪泪泻泽洁浅浆浇济浏浑浓涂涛润涨渊渐渔湾湿溃滚满滤滨潜灭灯灵灾炉点炼烂烟烧热爱牵状犹独狮猎献玛环现琐琼电画畅疗疟疮疯痒痪痴瘫皱盏盐监盖盗盘睁瞒矫矾矿码砖砚础确碍礼祸禄离秃种积称税稳穷窃窍窝竖竞笔笼筑筛签简类紧纠红纤约级纪纬纯纱纲纳纵纷纸纹纺线练组绅细织终绍经绑绒结绕绘给络绝绞统绣继续维绵绸综绿缀缆缎缓编缘缚缝缠缩缴网罗罚罢义习乡书长门闪闭问闲间闷闻阀阅阔队阳阴阵阶际陆陈险随隐难雏雾页顶项顺须预领颇频颗题颜额风飘飞饭饮饰饱饼馆马驱驶驻驼骂骄验骗骤鱼鲁鲜鸟鸡鸣鸥鸦鸭鸽鹅麦黄齐齿龙'
]

// Terms this catalog deliberately does not use, and the Taiwan form to use instead.
const FORBIDDEN_TERMS: Record<string, string> = {
  // OpenCC phrase-table over-conversions: the glyphs are Traditional but the word is wrong.
  許可權: '權限',
  全域性: '全域',
  型別: '類型',
  例項: '實例',
  對映: '映射',
  映象: '鏡像',
  擴充套件: '擴充功能',
  控制元件: '控制項',
  高階: '進階',
  進位制: '進位',
  稽核: '審核',
  首選項: '偏好設定',
  引數: '參數',
  釋出: '發布',
  富文字: '豐富',
  賬: '帳',
  臺: '台',
  // Mainland vocabulary.
  匹配: '符合',
  後台: '背景',
  選項卡: '分頁',
  標籤頁: '分頁',
  倉庫: '存放庫',
  儲存庫: '存放庫',
  配置: '設定',
  本地: '本機',
  計算機: '電腦',
  自定義: '自訂',
  更改: '變更',
  身份: '身分',
  只讀: '唯讀',
  單元格: '儲存格',
  快捷方式: '捷徑或快速鍵',
  資源管理器: '檔案總管或資源管理員',
  智慧體: 'Agent',
  權杖: 'Token',
  快進: 'fast-forward',
  克隆: 'Clone',
  拼寫: '拼字',
  下劃線: '底線',
  工具欄: '工具列',
  標題欄: '標題列',
  實時: '即時',
  重啟: '重新啟動',
  複用: '重複使用',
  郵箱: '信箱',
  谷歌: 'Google',
  回車: 'Enter',
  命令提示符: '命令提示字元'
}

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}) {
  if (typeof node === 'string') {
    out[prefix] = node
    return out
  }
  if (!node || typeof node !== 'object') {
    return out
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out)
  }
  return out
}

const entries = Object.entries(flatten(zhTW))

describe('zh-TW catalog', () => {
  it('is written entirely in Traditional script', () => {
    const simplified = new Set(SIMPLIFIED_ONLY)
    const offenders = entries
      .filter(([key]) => key !== SIMPLIFIED_ENDONYM_KEY)
      .flatMap(([key, value]) =>
        [...value]
          .filter((char) => simplified.has(char))
          .map((char) => `${key}: ${char} in "${value}"`)
      )
    expect(offenders).toEqual([])
  })

  it('keeps the Simplified Chinese endonym unconverted', () => {
    // Converting it to 中文（簡體） would label the zh catalog in the wrong script.
    expect(flatten(zhTW)[SIMPLIFIED_ENDONYM_KEY]).toBe('中文（简体）')
    expect(flatten(en)[SIMPLIFIED_ENDONYM_KEY]).toBe('中文（简体）')
  })

  it('uses Taiwan wording rather than Mainland or over-converted terms', () => {
    const offenders = entries.flatMap(([key, value]) =>
      Object.entries(FORBIDDEN_TERMS)
        .filter(([term]) => value.includes(term))
        .map(([term, replacement]) => `${key}: "${term}" should be "${replacement}" — ${value}`)
    )
    expect(offenders).toEqual([])
  })
})
