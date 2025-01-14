const qs = require('querystring')
const RuleSet = require('webpack/lib/RuleSet')
const { resolveCompiler } = require('./compiler')

const id = 'vue-loader-plugin'
const NS = 'vue-loader'

class VueLoaderPlugin {
  apply(compiler) {
    // add NS marker so that the loader can detect and report missing plugin
    if (compiler.hooks) {
      // webpack 4
      compiler.hooks.compilation.tap(id, (compilation) => {
        const normalModuleLoader = compilation.hooks.normalModuleLoader
        normalModuleLoader.tap(id, (loaderContext) => {
          loaderContext[NS] = true
        })
      })
    } else {
      // webpack < 4
      compiler.plugin('compilation', (compilation) => {
        compilation.plugin('normal-module-loader', (loaderContext) => {
          loaderContext[NS] = true
        })
      })
    }

    // use webpack's RuleSet utility to normalize user rules
    const rawRules = compiler.options.module.rules
    const { rules } = new RuleSet(rawRules)

    // find the rule that applies to vue files
    let vueRuleIndex = rawRules.findIndex(createMatcher(`foo.vue`))
    if (vueRuleIndex < 0) {
      vueRuleIndex = rawRules.findIndex(createMatcher(`foo.vue.html`))
    }
    const vueRule = rules[vueRuleIndex]

    if (!vueRule) {
      throw new Error(
        `[VueLoaderPlugin Error] No matching rule for .vue files found.\n` +
          `Make sure there is at least one root-level rule that matches .vue or .vue.html files.`
      )
    }

    if (vueRule.oneOf) {
      throw new Error(
        `[VueLoaderPlugin Error] vue-loader 15 currently does not support vue rules with oneOf.`
      )
    }

    // get the normalized "use" for vue files
    const vueUse = vueRule.use
    // get vue-loader options
    const vueLoaderUseIndex = vueUse.findIndex((u) => {
      return /^vue-loader|(\/|\\|@)vue-loader/.test(u.loader)
    })

    if (vueLoaderUseIndex < 0) {
      throw new Error(
        `[VueLoaderPlugin Error] No matching use for vue-loader is found.\n` +
          `Make sure the rule matching .vue files include vue-loader in its use.`
      )
    }

    // make sure vue-loader options has a known ident so that we can share
    // options by reference in the template-loader by using a ref query like
    // template-loader??vue-loader-options
    const vueLoaderUse = vueUse[vueLoaderUseIndex]
    vueLoaderUse.ident = 'vue-loader-options'
    vueLoaderUse.options = vueLoaderUse.options || {}

    // rule for template compiler
    const templateCompilerRule = {
      loader: require.resolve('./loaders/templateLoader'),
      resourceQuery: (query) => {
        const parsed = qs.parse(query.slice(1))
        return parsed.vue != null && parsed.type === 'template'
      },
      options: vueLoaderUse.options
    }

    // for each rule that matches plain .js/.ts files, also create a clone and
    // match it against the compiled template code inside *.vue files, so that
    // compiled vue render functions receive the same treatment as user code
    // (mostly babel)
    const { is27 } = resolveCompiler(compiler.options.context)
    let jsRulesForRenderFn = []
    if (is27) {
      const matchesJS = createMatcher(`test.js`)
      // const matchesTS = createMatcher(`test.ts`)
      jsRulesForRenderFn = rules
        .filter((r) => r !== vueRule && matchesJS(r))
        .map(cloneRuleForRenderFn)
    }

    const stylePostLoaderRule = {
      loader: require.resolve('./loaders/stylePostLoader'),
      resourceQuery: query => {
        const parsed = qs.parse(query.slice(1))
        return parsed.vue != null && parsed.type === 'style'
      }
    }

    for (const rule of rules) {
      const loaders = rule.use
      for (let i in loaders) {
        if (loaders[i].loader === 'css-loader') {
          loaders.splice(++i, 0, stylePostLoaderRule)
        }
      }
    }
    // replace original rules
    compiler.options.module.rules = [
      ...jsRulesForRenderFn,
      ...(is27 ? [templateCompilerRule] : []),
      ...rules
    ]
  }
}

function createMatcher(fakeFile) {
  return (rule, i) => {
    // #1201 we need to skip the `include` check when locating the vue rule
    const clone = Object.assign({}, rule)
    delete clone.include
    const normalized = RuleSet.normalizeRule(clone, {}, '')
    return !rule.enforce && normalized.resource && normalized.resource(fakeFile)
  }
}

function cloneRuleForRenderFn(rule) {
  const resource = rule.resource
  const resourceQuery = rule.resourceQuery
  let currentResource
  const res = {
    ...rule,
    resource: (resource) => {
      currentResource = resource
      return true
    },
    resourceQuery: (query) => {
      const parsed = qs.parse(query.slice(1))
      if (parsed.vue == null || parsed.type !== 'template') {
        return false
      }
      const fakeResourcePath = `${currentResource}.${parsed.ts ? `ts` : `js`}`
      if (resource && !resource(fakeResourcePath)) {
        return false
      }
      if (resourceQuery && !resourceQuery(query)) {
        return false
      }
      return true
    }
  }

  if (rule.rules) {
    res.rules = rule.rules.map(cloneRuleForRenderFn)
  }

  if (rule.oneOf) {
    res.oneOf = rule.oneOf.map(cloneRuleForRenderFn)
  }

  return res
}

VueLoaderPlugin.NS = NS
module.exports = VueLoaderPlugin
