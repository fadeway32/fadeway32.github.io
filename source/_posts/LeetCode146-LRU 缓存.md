---

layout: LRU(最近最少使用)

title: LRU最近最少使用缓存

tags: LeetCode

categories: Web

top: 45

path: /article/1754796352

abbrlink: 1754796352

date: 2024-04-26 21:34:00


---

[146. LRU 缓存](https://leetcode.cn/problems/lru-cache/)

已解答

中等

相关标签

相关企业

请你设计并实现一个满足 [LRU (最近最少使用) 缓存](https://baike.baidu.com/item/LRU) 约束的数据结构。

实现 `LRUCache` 类：

- `LRUCache(int capacity)` 以 **正整数** 作为容量 `capacity` 初始化 LRU 缓存
- `int get(int key)` 如果关键字 `key` 存在于缓存中，则返回关键字的值，否则返回 `-1` 。
- `void put(int key, int value)` 如果关键字 `key` 已经存在，则变更其数据值 `value`
  ；如果不存在，则向缓存中插入该组 `key-value` 。如果插入操作导致关键字数量超过 `capacity` ，则应该 **逐出** 最久未使用的关键字。

函数 `get` 和 `put` 必须以 `O(1)` 的平均时间复杂度运行

**示例：**

```java
输入
["LRUCache", "put", "put", "get", "put", "get", "put", "get", "get", "get"]
[[2], [1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]]
输出
[null, null, null, 1, null, -1, null, -1, 3, 4]

解释
LRUCache lRUCache = new LRUCache(2);
lRUCache.put(1, 1); // 缓存是 {1=1}
lRUCache.put(2, 2); // 缓存是 {1=1, 2=2}
lRUCache.get(1);    // 返回 1
lRUCache.put(3, 3); // 该操作会使得关键字 2 作废，缓存是 {1=1, 3=3}
lRUCache.get(2);    // 返回 -1 (未找到)
lRUCache.put(4, 4); // 该操作会使得关键字 1 作废，缓存是 {4=4, 3=3}
lRUCache.get(1);    // 返回 -1 (未找到)
lRUCache.get(3);    // 返回 3
lRUCache.get(4);    // 返回 4
```

~~~java
class LRUCache {

    class DlinkedNode{
        int key;
        int value;
        DlinkedNode prev;
        DlinkedNode next;
        public DlinkedNode (){}
        public DlinkedNode(int _key,int _value){
            this.key = _key;
            this.value = _value;

        }
    }

   public Map<Integer,DlinkedNode> cache = new HashMap<>();
   private int size;
   private int capacity;
   private DlinkedNode head;
   private DlinkedNode tail; 

    public LRUCache(int capacity) {
        this.size = 0 ;
        this.capacity = capacity;
        head = new DlinkedNode();
        tail = new DlinkedNode();
        head.next = tail;
        tail.prev = head;
    }
    
    public int get(int key) {
        DlinkedNode node = cache.get(key);
        if(node == null){
            return -1;
        }
        moveTohead(node);
        return node.value;
    
    }

    public void moveTohead(DlinkedNode  node ){
        removeNode(node);
        addToHead(node);
    }

    public void  addToHead(DlinkedNode node){
        node.prev= head;
        node.next = head.next;
        head.next.prev = node;
        head.next= node;
    } 

    public DlinkedNode removeTail(){
        DlinkedNode prev = tail.prev;
        prev.prev.next = tail;
        tail.prev = prev.prev;
        return prev;
    }

    public void removeNode(DlinkedNode  node){
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    
    public void put(int key, int value) {
        DlinkedNode node = cache.get(key);
        if(node ==null){
            node = new DlinkedNode(key,value);

            cache.put(key,node);
            addToHead(node);
            ++size;
            if(size > capacity){
               DlinkedNode tail = removeTail();
                cache.remove(tail.key);
                --size;
            }

        }else{
            node.value = value;
            moveTohead(node);

        }
    }
}

/**
 * Your LRUCache object will be instantiated and called as such:
 * LRUCache obj = new LRUCache(capacity);
 * int param_1 = obj.get(key);
 * obj.put(key,value);
 */
~~~

