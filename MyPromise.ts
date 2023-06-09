class MyPromise {
  // 初始状态为 pending
  private state = State.Pending;

  // 保存 Promise 的结果
  private result?: any;

  // 传入 then 的回调函数会被放入队列中, 有多个 then 时，队列中的回调函数会依次调用
  private handlersQueue: Handler[] = [];

  // 构造函数
  constructor(
    // 外部传入的 executor 函数
    // 使用了 revealing constructor pattern, 用来开放内部的 resolve 和 reject 函数给外部，而且外部仅能在 new Promise 时调用
    executor: (
      // executor 函数接收两个参数，分别是 resolve 和 reject，外部可以使用它们
      resolve: (value: any | MyPromise) => void,
      reject: (reason?: any) => void
    ) => void
  ) {
    // 外部给的 executor 中的代码如果抛出了错误, 这里会通过调用 reject 来捕获错误，并且改变状态 pending -> rejected
    try {
      // new Promise 时立即执行 executor
      // 传入 resolve 和 reject 函数给外部，供外部调用
      executor(this.resolve, this.reject);
    } catch (e) {
      this.reject(e);
    }
  }

  /**
   * 虽然是私有方法，但是 resolve 方法通过构造函数中的 executor 函数传入外部，外部可以通过调用它将 Promise 的状态改为 resolved
   * @param value 外部通过调用 resolve(..) 传入的变量
   */
  private resolve = (value: any | MyPromise) => {
    this.setResultAndStatus(value, State.Resolved);
  };

  /**
   * 和 resolve 方法一样，通过构造函数中的 executor 函数传入外部，外部可以通过调用它将 Promise 的状态改为 rejected
   * @param reason 外部通过调用 reject(..) 传入的变量
   */
  private reject = (reason?: any) => {
    this.setResultAndStatus(reason, State.Rejected);
  };

  /**
   * Promise 的内部函数，只能被内部的 resolve 和 reject 方法调用，外部无法直接调用
   * @param value resolve 或 reject 方法传入的变量
   * @param state resolved 或 rejected
   * @returns void
   */
  private setResultAndStatus = (value: any, state: State) => {
    // 这里可以看到 status 是不可逆的
    if (this.state !== State.Pending) {
      return;
    }

    /**
     * 如果在 executor 中，我们给 resolve 方法传入了一个有 then 方法(thenable)的对象，那么这里就会调用它的 then 方法
     * 同时还可以看出，resolve(new Promise(...)) 会把新的 Promise 的状态和结果传递给外部的 Promise
     */
    if (isThenable(value)) {
      // 因为 then 是箭头函数，所以 then 里面的 this 指向的是外部的 promise，而不是 resolve(new Promise(...)) 中的 promise
      value.then(this.resolve, this.reject);
      return;
    }

    // 更新状态和结果，这里可以看到 result 的值只可能是 fullfilled 或 rejected
    this.state = state;
    this.result = value;

    // 处理所有的 handler 回调函数，也就是处理所有通过 then 注册的回调函数（不是链式调用）
    this.executeHandlers();
  };

  /**
   * 处理所有的 handler 回调函数，也就是处理所有通过 then 注册的回调函数（不是链式调用）
   */
  private executeHandlers = () => {
    // 如果状态还是 pending，说明 executor 中的异步代码还没有结束。直接返回，不执行。
    if (this.state === State.Pending) {
      // 不执行 handlers 是没关系的，因为 handlers 都保存在 handlersQueue 中，等待着状态改变后会再执行的
      return;
    }

    // 模拟放入微任务队列, 这里可以看出 then 中的回调函数会在 event loop 的微任务阶段执行
    runAsync(() => {
      /**
       * 这里可以看出，handlersQueue + Status + 微任务队列实现了 Promise 的异步调用
       * 再也不怕 executor 中执行异步代码会导致 then 中的 handlers 执行不到啦
       */
      this.handlersQueue.forEach((handler) => {
        // 根据状态执行不同的回调函数
        if (this.state === State.Resolved) {
          // 把 executor 中通过调用 resolve(..) 拿到的结果传给回调函数
          handler.handleOnFullfilled(this.result);
        } else {
          // 和上面一样，只不过是把 reject(..) 的结果传给回调函数
          handler.handleOnRejected(this.result);
        }
      });

      // 执行完毕后，清空 handlers
      this.handlersQueue = [];
    });
  };

  /**
   * Promise 的核心方法，用来注册回调函数
   * @param onFullfilled status 为 resolved 时调用的函数
   * @param onRejected status 为 rejected 时调用的函数
   * @returns 返回一个新的 promise, 以实现链式调用
   */
  then = (
    onFullfilled?: (value: any) => any | MyPromise,
    onRejected?: (reason: any) => any | MyPromise
  ) => {
    // 返回一个新的 promise，这样可以实现链式调用，即 then 的返回值是个 Promise, 可以继续调用 then
    return new MyPromise((resolve: any, reject: any) => {
      // 定义一个 handler 对象，用来保存外部使用者给到 then 的回调函数
      const handler = {
        // then(arg1, arg2) 中的 arg1
        handleOnFullfilled: (value: any) => {
          if (!onFullfilled || typeof onFullfilled !== "function") {
            // 这里可以看到值穿透的原理：
            //  如果给 then 的不是个回调函数，那么新创建的 promise 的 result 直接设为 value
            resolve(value);
          } else {
            // 如果 then 中的回调函数执行时抛出了异常，需要调用 reject 改变新 promise 的状态,
            // 这样后面的 then 中的 onRejected 回调函数才能捕获到异常,
            // 如果不加 try catch，那么异常会被 global 捕获，链式调用会停止.
            try {
              // 这里可以看出，如果 then 中传的回调函数没有返回值，那么 resolve 的值就是 undefined
              resolve(onFullfilled(value as any | MyPromise));
            } catch (e) {
              // 通过 reject 改变新 promise 的状态并且把异常传递给后面的 then 中的 onRejected 回调函数
              reject(e);
            }
          }
        },
        // then(arg1, arg2) 中的 arg2
        handleOnRejected: (reason: any) => {
          // 和 handleThen 一样，如果没有给 catch 一个回调函数，那么直接返回上一个 promise 的错误信息
          if (!onRejected || typeof onRejected !== "function") {
            reject(reason);
          } else {
            try {
              // 这里可以看出，如果 promise 通过 reject 抛出错误被捕获到后, 没有继续向后抛错误，
              // 后面的 then 还是会继续走 onFullfilled 回调，而不会 catch 到错误
              // 例如下面的代码，大家想想第二个 then 的哪个回调参数会被调用？
              /**
               new Promise((_, reject) => {
                reject("errror");
               })
                .then(() => {console.log("ok")}, (e) => {console.log("fail", e)})
                .then(() => {console.log("ok 2")}, (e) => {console.log("fail 2, e")})
               */
              resolve(onRejected(reason as any | MyPromise));
            } catch (e) {
              // 和上面的 reject 同理
              reject(e);
            }
          }
        },
      };

      // 把 handler 放入队列中，等待状态改变后执行
      this.handlersQueue.push(handler);

      // 试着执行等待队列中的回调函数
      this.executeHandlers(); // then 中生成新 promise 的时候立即调用本次 promise 的 handlers
    });
  };

  /**
   * catch 内部其实就是调用 then，只不过第一个参数是 undefined
   */
  catch = (onRejected?: (reason: any) => any | MyPromise) => {
    // 相当于 promise.then(undefined, onRejected)
    return this.then(undefined, onRejected);
  };

  /**
   * finally 内部其实就是调用 then
   * 调用 onFinally，然后把上一层的结果原封不动的传给下一层
   * 如果上一层是 resolved，那么就把结果传给下一层 then
   * 如果上一层是 rejected，那么就抛出错误，下层的 catch 就可以捕获到错误
   */
  finally = (onFinally: () => void) => {
    // then 返回新的 promise，这里可以看出，finally 后还是可以继续链式调用的
    return this.then(
      (value) => {
        // finally 回调不会给到我们任何参数, 所以 promise.finally((拿不到参数) => {})
        onFinally();
        return value;
      },
      (reason) => {
        onFinally();
        // 原封不动的抛出错误给到下一层 catch
        throw reason;
      }
    );
  };
}

enum State {
  Pending,
  Resolved,
  Rejected,
}

const isThenable = (obj: any): obj is MyPromise => {
  return typeof obj?.then === "function";
};

const runAsync = (cb: () => void) => {
  setTimeout(cb, 0);
};

type Handler = {
  handleOnFullfilled: (value: any) => void;
  handleOnRejected: (reason?: any) => void;
};

export default MyPromise;
