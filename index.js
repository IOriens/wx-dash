const path = require('path')
const baseUrl = 'https://developers.weixin.qq.com/miniprogram/dev/'
const got = require('got')
const cheerio = require('cheerio')
const fs = require('fs-extra')
const url = require('url')
const cpFile = require('cp-file')
const et = require('et-improve')
const tempFn = et.compileFile('./page.et')
const glob = require('glob-promise')
const destDir = path.resolve(
  __dirname,
  'wxapp.docset/Contents/Resources/Documents',
)
const Sequelize = require('sequelize')
const del = require('del')

// 这些是函数, 但是官方文档没加 ()
const pageFunctions = ['onTabItemTap', 'onPullDownRefresh']
const ignorePattern = /^(参数|例子|定义|使用方法|示例代码|语法)/

const uselessElements = '.relative_an,.relative_ans,.page-edit,.footer'

async function downloadHtml() {
  let configs = [
    {
      dir: 'component',
      root: '',
    },
    {
      dir: 'reference',
      root: 'configuration/app.html',
    },
    {
      dir: 'api',
      root: '',
    },
  ]
  for (let conf of configs) {
    let { dir, root } = conf
    let rootUrl = `${baseUrl}${dir}/${root}`
    let fileRoot = path.resolve(destDir, dir)
    let paths = []
    let response = await got(rootUrl)

    const $ = cheerio.load(response.body)
    $('.TreeNavigation a').each((i, link) => {
      let href = $(link).attr('href').replace(/#.*$/, '')
      if (paths.indexOf(href) == -1) {
        paths.push(href)
      }
    })

    // download paths
    for (let p of paths) {
      // if (/\/$/.test(p)) p = p + 'index.html'
      let remote = url.resolve(rootUrl, p)
      console.log(remote)
      let base = path.dirname(path.resolve(fileRoot, p))
      // await fs.ensureDir(base)
      let s = /\.html/.test(p) ? p : `${p}.html`
      s = s.replace(`/miniprogram/dev/${dir}/`, '')
      let file = path.resolve(fileRoot, s)
      let response = await got(remote)
      const $ = cheerio.load(response.body)
      let title = $('title').text().replace(' | 微信开放文档', '')
      let len = p.split('/').length
      $(uselessElements).remove()
      let content = tempFn({
        title,
        path: new Array(len).fill('..').join('/'),
        html: $('.page-inner').html(),
      })
      console.log(file)
      await fs.ensureFile(file)
      await fs.writeFile(file, content, 'utf8')
      console.log(`Downloaded ${path.resolve(fileRoot, s)}`)
    }
  }
}

async function generateAPI(SearchIndex) {
  console.log('generateAPI')
  let files = await glob(`${destDir}/api/**/*.html`)
  let tags = ['h1', 'h2', 'h3', 'h4']
  for (let file of files) {
    let content = await fs.readFile(path.resolve(__dirname, file), 'utf8')
    const $ = cheerio.load(content)
    let title = $('title').text()
    let htmlPath = path.relative(destDir, file)
    for (let tag of tags) {
      for (let node of Array.from($(tag))) {
        let id = $(node).attr('id')
        let path = `${htmlPath}#${encodeURIComponent(id)}`
        let text = $(node).text()
        if (ignorePattern.test(id)) continue
        if (/^(api|tip|bug)$/i.test(id) || /--/.test(id)) {
          // Section
          let t = `${tag == 'h1' ? '' : title + ' · '}${text}`
          await SearchIndex.create({
            name: t,
            type: 'Section',
            path,
          })
        } else if (text == 'restore' && /canvas/.test(file)) {
          await SearchIndex.create({
            name: 'canvasContext.restore',
            type: 'Method',
            path,
          })
        } else if (text == 'Color' && /canvas/.test(file)) {
          // Section
          let t = `Canvas · Color`
          await SearchIndex.create({
            name: t,
            type: 'Section',
            path,
          })
        } else if (/^[\w|-]+$/.test(id)) {
          if (/\./.test(text)) {
            // Method
            await SearchIndex.create({
              name: text.replace(/\(.*\)/, ''),
              type: 'Method',
              path,
            })
          } else {
            if (/\(.*\)/.test(text) || pageFunctions.indexOf(text) !== -1) {
              await SearchIndex.create({
                name: `page.${text}`,
                type: 'Function',
                path,
              })
            } else {
              // Object
              await SearchIndex.create({
                name: text,
                type: 'Object',
                path,
              })
            }
          }
        } else {
          let t = `${tag == 'h1' ? '' : title + ' · '}${text}`
          await SearchIndex.create({
            name: t,
            type: 'Section',
            path,
          })
        }
      }
    }
  }
}

async function generateComponent(SearchIndex) {
  console.log('generateComponent')
  let files = await glob(`${destDir}/component/**/*.html`)
  let tags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  for (let file of files) {
    let content = await fs.readFile(path.resolve(__dirname, file), 'utf8')
    const $ = cheerio.load(content)
    let title = $('title').text()
    let htmlPath = path.relative(destDir, file)
    for (let tag of tags) {
      for (let node of Array.from($(tag))) {
        let id = $(node).attr('id')
        let path = `${htmlPath}#${encodeURIComponent(id)}`
        let text = $(node).text()
        if (tag == 'h4' && !/--/.test(id) && !/tips/i.test(id)) {
          await SearchIndex.create({
            name: text,
            type: 'Tag',
            path,
          })
        } else {
          let t = `${tag == 'h1' ? '' : title + ' · '}${text}`
          await SearchIndex.create({
            name: t,
            type: 'Section',
            path,
          })
        }
      }
    }
    // parse attributes
    let tables = Array.from($('table'))
    for (let table of tables) {
      let th = $(table).find('thead th:first-child')
      if (th.text() == '属性名') {
        let tds = Array.from($(table).find('tr > td:first-child'))
        for (let td of tds) {
          let name = $(td).text()
          let id = `${title}-${name}`
          $(td).attr('id', id)
          let path = `${htmlPath}#${encodeURIComponent(id)}`
          await SearchIndex.create({
            name,
            type: 'Attribute',
            path,
          })
        }
      }
    }
    await fs.writeFile(file, $.html(), 'utf8')
  }
}


async function generateFramework(SearchIndex) {
  console.log('generateFramework')
  let files = await glob(`${destDir}/reference/**/*.html`)
  for (let file of files) {
    let content = await fs.readFile(path.resolve(__dirname, file), 'utf8')
    const $ = cheerio.load(content)
    let htmlPath = path.relative(destDir, file)

    let title = $('title').text()
    await SearchIndex.create({
      name: title,
      type: 'Guide',
      path: htmlPath,
    })
  }
}

async function start() {
  await fs.ensureDir(destDir)
  await cpFile('icon.png', path.resolve(destDir, '../../../icon.png'))
  await cpFile('info.plist', path.resolve(destDir, '../../info.plist'))
  await cpFile('style.css', path.join(destDir, 'style.css'))
  await cpFile('website.css', path.join(destDir, 'website.css'))
  await downloadHtml()

  const dbFile = path.resolve(destDir, '../docSet.dsidx')
  await del([dbFile])
  const seq = new Sequelize('database', 'username', 'password', {
    dialect: 'sqlite',
    operatorsAliases: false,
    // SQLite only
    storage: dbFile,
    logging: false,
  })
  await seq.authenticate()
  const SearchIndex = seq.define(
    'searchIndex',
    {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: Sequelize.STRING,
      },
      type: {
        type: Sequelize.STRING,
      },
      path: {
        type: Sequelize.STRING,
      },
    },
    {
      freezeTableName: true,
      timestamps: false,
    },
  )

  await SearchIndex.sync({ force: true })

  await generateFramework(SearchIndex)
  await generateAPI(SearchIndex)
  await generateComponent(SearchIndex)
}

start()
