import { Dict, makeArray, MaybeArray } from 'cosmokit'
import { Eval, Update } from './eval'
import { Field, Model } from './model'
import { Query } from './query'
import { Flatten, Indexable, Keys } from './utils'
import { Direction, Executable, Modifier, Selection, Selector } from './selection'
import ns from 'ns-require'

export type Result<S, K, T = (...args: any) => any> = {
  [P in keyof S as S[P] extends T ? P : P extends K ? P : never]: S[P]
}

export namespace Driver {
  export interface Stats {
    size?: number
    tables?: Dict<TableStats>
  }

  export interface TableStats {
    count: number
    size: number
  }

  export type Cursor<K extends string = never> = K[] | CursorOptions<K>

  export interface CursorOptions<K> {
    limit?: number
    offset?: number
    fields?: K[]
    sort?: Dict<Direction>
  }
}

const scope = ns({
  namespace: 'minato',
  prefix: 'driver',
  official: 'minatojs',
})

export class Database<S = any> {
  public tables: { [K in Keys<S>]?: Model<S[K]> } = Object.create(null)
  public drivers: Record<keyof any, Driver> = Object.create(null)
  private tasks: Dict<Promise<void>> = Object.create(null)
  private stashed = new Set<string>()

  refresh() {
    for (const name in this.tables) {
      this.tasks[name] = this.prepare(name)
    }
  }

  connect<T>(constructor: Driver.Constructor<T>, config?: T, name?: string): Promise<void>
  connect(constructor: string, config?: any, name?: string): Promise<void>
  async connect(constructor: string | Driver.Constructor, config: any, name = 'default') {
    if (typeof constructor === 'string') {
      constructor = scope.require(constructor) as Driver.Constructor
    }
    const driver = new constructor(this, config)
    await driver.start()
    this.drivers[name] = driver
    this.refresh()
  }

  private getDriver(name: string) {
    const model: Model = this.tables[name]
    if (model.driver) return this.drivers[model.driver]
    return Object.values(this.drivers)[0]
  }

  private async prepare(name: string) {
    this.stashed.add(name)
    await this.tasks[name]
    return new Promise<void>(async (resolve) => {
      Promise.resolve().then(async () => {
        if (this.stashed.delete(name)) {
          await this.getDriver(name)?.prepare(name)
        }
        resolve()
      })
    })
  }

  extend<K extends Keys<S>>(name: K, fields: Field.Extension<S[K]>, config: Model.Config<S[K]> = {}) {
    let model = this.tables[name]
    if (!model) {
      model = this.tables[name] = new Model(name)
      model.driver = config.driver
    }
    model.extend(fields, config)
    this.tasks[name] = this.prepare(name)
  }

  select<T extends Selector<S>>(table: T, query?: Query<Selector.Resolve<S, T>>): Selection<Selector.Resolve<S, T>> {
    return new Selection(this.getDriver(table), table, query)
  }

  async get<T extends Keys<S>, K extends Keys<S[T]>>(table: T, query: Query<Selector.Resolve<S, T>>, cursor?: Driver.Cursor<K>): Promise<Result<S[T], K>[]> {
    await this.tasks[table]
    if (Array.isArray(cursor)) {
      cursor = { fields: cursor }
    } else if (!cursor) {
      cursor = {}
    }

    const selection = this.select(table, query)
    if (cursor.fields) selection.project(cursor.fields)
    if (cursor.limit !== undefined) selection.limit(cursor.limit)
    if (cursor.offset !== undefined) selection.offset(cursor.offset)
    if (cursor.sort) {
      for (const field in cursor.sort) {
        selection.orderBy(field as any, cursor.sort[field])
      }
    }
    return selection.execute()
  }

  eval<K extends Keys<S>, T>(table: K, expr: Selection.Callback<S[K], T>, query?: Query): Promise<T>
  /** @deprecated use selection callback instead */
  eval(table: Keys<S>, expr: any, query?: Query): Promise<any>
  async eval(table: Keys<S>, expr: any, query?: Query) {
    await this.tasks[table]
    return this.select(table, query)
      .evaluate(typeof expr === 'function' ? expr : () => expr)
      .execute()
  }

  async set<T extends Keys<S>>(table: T, query: Query<Selector.Resolve<S, T>>, update: Selection.Yield<S[T], Update<S[T]>>) {
    await this.tasks[table]
    const sel = this.select(table, query)
    if (typeof update === 'function') update = update(sel.row)
    const primary = makeArray(sel.model.primary)
    if (primary.some(key => key in update)) {
      throw new TypeError(`cannot modify primary key`)
    }
    await sel.action('set', sel.model.format(update)).execute()
  }

  async remove<T extends Keys<S>>(table: T, query: Query<Selector.Resolve<S, T>>) {
    await this.tasks[table]
    const sel = this.select(table, query)
    await sel.action('remove').execute()
  }

  async create<T extends Keys<S>>(table: T, data: Partial<S[T]>): Promise<S[T]> {
    await this.tasks[table]
    const sel = this.select(table)
    return sel.action('create', sel.model.create(data)).execute()
  }

  async upsert<T extends Keys<S>>(table: T, upsert: Selection.Yield<S[T], Update<S[T]>[]>, keys?: MaybeArray<Keys<Flatten<S[T]>, Indexable>>) {
    await this.tasks[table]
    const sel = this.select(table)
    if (typeof upsert === 'function') upsert = upsert(sel.row)
    upsert = upsert.map(item => sel.model.format(item))
    keys = makeArray(keys || sel.model.primary) as any
    await sel.action('upsert', upsert, keys).execute()
  }

  async stopAll() {
    const drivers = Object.values(this.drivers)
    this.drivers = Object.create(null)
    await Promise.all(drivers.map(driver => driver.stop()))
  }

  async dropAll() {
    await Promise.all(Object.values(this.drivers).map(driver => driver.drop()))
  }

  async stats() {
    const stats: Driver.Stats = { size: 0, tables: {} }
    await Promise.all(Object.values(this.drivers).map(async (driver) => {
      const { size, tables } = await driver.stats()
      stats.size += size
      Object.assign(stats.tables, tables)
    }))
    return stats
  }
}

export namespace Driver {
  export type Constructor<T = any> = new (database: Database, config?: T) => Driver
}

export abstract class Driver {
  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract drop(): Promise<void>
  abstract stats(): Promise<Driver.Stats>
  abstract prepare(name: string): Promise<void>
  abstract get(sel: Executable, modifier: Modifier): Promise<any>
  abstract eval(sel: Executable, expr: Eval.Expr): Promise<any>
  abstract set(sel: Executable, data: Update): Promise<void>
  abstract remove(sel: Executable): Promise<void>
  abstract create(sel: Executable, data: any): Promise<any>
  abstract upsert(sel: Executable, data: any[], keys: string[]): Promise<void>

  constructor(public database: Database) {}

  model(name: string) {
    const model = this.database.tables[name]
    if (model) return model
    throw new TypeError(`unknown table name "${name}"`)
  }

  execute(executable: Executable) {
    const { type, args } = executable
    return this[type as any](executable, ...args)
  }
}
