---

layout: 字节码插桩

title: LeetCode22.括号生成

tags: Web

categories: LeetCode

top: 20

path: /article/1717340312

abbrlink: 1717340312

date: 2024-06-02 22:58:31


---

# LeetCode22.括号生成

数字 `n` 代表生成括号的对数，请你设计一个函数，用于能够生成所有可能的并且 **有效的** 括号组合。

**示例 1：**

```
输入：n = 3
输出：["((()))","(()())","(())()","()(())","()()()"]
```

**示例 2：**

```
输入：n = 1
输出：["()"]
```

~~~java
class Soultion{
    
    
    
    public List<String> getResult(int n){
        List<Sting> list = new ArrayList<>();
        appendList(0,0,"",list);
        return  list;
        
    }
    
    public void appendList(int left ,int right, String s ,List<String> list){
        if(left == n && right == n){
            list.add(s);
            return;
        }
        
        if(left < n){
            appendList(left +1 ,right,s+"(",list);
        }
        
        if(right < left){
            appendList(left ,right + 1,s+")",list);
        }
           
        
        
    }
    
    
    
    
}


~~~

